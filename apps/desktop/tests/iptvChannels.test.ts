import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import {
  countIptvChannels,
  deleteIptvSource,
  insertIptvSource,
  listIptvChannels,
  listIptvGroups,
  listIptvSources,
  recordIptvRefresh,
  recordIptvStreamHealth,
  replaceIptvChannels,
  replaceIptvProgrammes,
} from '../src/main/databaseIptvRepository.ts';
import { iptvChannelSearchText, iptvSearchTerms } from '../src/shared/iptvSearch.ts';
import type { ParsedIptvChannel } from '../src/main/iptv/m3uPlaylist.ts';

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  migrateDatabase(database);
  return database;
}

function channel(name: string, overrides: Partial<ParsedIptvChannel> = {}): ParsedIptvChannel {
  const base = {
    channelId: overrides.channelId || name.toLowerCase().replace(/\s+/g, '-'),
    name,
    tvgId: overrides.tvgId ?? '',
    tvgName: overrides.tvgName ?? '',
    logoUrl: overrides.logoUrl ?? '',
    groupTitle: overrides.groupTitle ?? '',
    streamUrl: overrides.streamUrl || `https://stream.example/${encodeURIComponent(name)}`,
    searchText: '',
  };
  return { ...base, searchText: iptvChannelSearchText(base) };
}

// Listing shows only streams whose latest health check succeeded, so fixtures
// record a passing check for every channel they add.
function replaceVerifiedChannels(
  database: BetterSqlite3.Database,
  sourceId: string,
  channels: ParsedIptvChannel[],
): void {
  replaceIptvChannels(database, sourceId, channels);
  for (const entry of channels) {
    recordIptvStreamHealth(database, {
      streamUrl: entry.streamUrl,
      status: 'ok',
      reason: '',
      failures: 0,
      hidden: false,
      checkedAt: 1,
      analyzedAt: 1,
    });
  }
}

function seed(database: BetterSqlite3.Database): string {
  const source = insertIptvSource(database, {
    id: 'source-1',
    name: 'Provider',
    playlistUrl: 'https://provider.example/playlist.m3u',
    epgUrl: '',
  });
  replaceVerifiedChannels(database, source.id, [
    channel('Sky Sports Main Event', { groupTitle: 'Sports', tvgId: 'sky.sports.main' }),
    channel('Sky Sports F1', { groupTitle: 'Sports', tvgId: 'sky.sports.f1' }),
    channel('Sky News', { groupTitle: 'News', tvgId: 'sky.news' }),
    channel('BBC One HD', { groupTitle: 'Entertainment', tvgId: 'bbc.one' }),
    channel('Canal+ Décalé', { groupTitle: 'Entertainment', tvgId: 'canal.plus' }),
  ]);
  return source.id;
}

test('search normalization folds accents and punctuation', () => {
  assert.equal(iptvChannelSearchText({ name: 'Canal+ Décalé', groupTitle: 'Cinéma' }), 'canal decale cinema');
  assert.deepEqual(iptvSearchTerms('  Sky   SPORTS  '), ['sky', 'sports']);
  assert.deepEqual(iptvSearchTerms('   '), []);
});

test('channel search requires every term and can be combined with a group', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  const all = listIptvChannels(database, { sourceId });
  assert.equal(all.length, 5);

  const skySports = listIptvChannels(database, { sourceId, query: 'sky sport' });
  assert.deepEqual(skySports.map((row) => row.name), ['Sky Sports Main Event', 'Sky Sports F1']);
  assert.equal(countIptvChannels(database, { sourceId, query: 'sky sport' }), 2);

  const news = listIptvChannels(database, { sourceId, query: 'sky', group: 'News' });
  assert.deepEqual(news.map((row) => row.name), ['Sky News']);

  // Accents in the catalog are reachable from an ASCII query.
  assert.deepEqual(
    listIptvChannels(database, { sourceId, query: 'decale' }).map((row) => row.name),
    ['Canal+ Décalé'],
  );
  database.close();
});

test('channel search treats SQL wildcards in a query as literal text', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  // "%" normalizes away entirely rather than matching every channel.
  assert.equal(listIptvChannels(database, { sourceId, query: '%' }).length, 5);
  assert.equal(listIptvChannels(database, { sourceId, query: 'sky%news' }).length, 1);
  database.close();
});

test('channel pages are stable and report the full match count', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  const firstPage = listIptvChannels(database, { sourceId, limit: 2, offset: 0 });
  const secondPage = listIptvChannels(database, { sourceId, limit: 2, offset: 2 });

  assert.deepEqual(firstPage.map((row) => row.name), ['Sky Sports Main Event', 'Sky Sports F1']);
  assert.deepEqual(secondPage.map((row) => row.name), ['Sky News', 'BBC One HD']);
  assert.equal(countIptvChannels(database, { sourceId }), 5);
  database.close();
});

test('A-Z and Z-A sort by name across pages while an omitted sort keeps playlist order', () => {
  const database = createDatabase();
  const sourceId = seed(database);
  const names = (request: Partial<Parameters<typeof listIptvChannels>[1]>) => [
    ...listIptvChannels(database, { sourceId, limit: 3, offset: 0, ...request }),
    ...listIptvChannels(database, { sourceId, limit: 3, offset: 3, ...request }),
  ].map((row) => row.name);
  const alphabetical = ['BBC One HD', 'Canal+ Décalé', 'Sky News', 'Sky Sports F1', 'Sky Sports Main Event'];

  assert.deepEqual(names({ sort: 'name-asc' }), alphabetical);
  assert.deepEqual(names({ sort: 'name-desc' }), [...alphabetical].reverse());
  assert.deepEqual(names({}), ['Sky Sports Main Event', 'Sky Sports F1', 'Sky News', 'BBC One HD', 'Canal+ Décalé']);
  database.close();
});

test('channels carry the now and next programme for their guide id', () => {
  const database = createDatabase();
  const sourceId = seed(database);
  const nowMs = Date.UTC(2024, 0, 15, 12, 30, 0);
  replaceIptvProgrammes(database, sourceId, [
    {
      tvgId: 'sky.news',
      startMs: Date.UTC(2024, 0, 15, 12, 0, 0),
      endMs: Date.UTC(2024, 0, 15, 13, 0, 0),
      title: 'Sky News At Noon',
      description: '',
    },
    {
      tvgId: 'sky.news',
      startMs: Date.UTC(2024, 0, 15, 13, 0, 0),
      endMs: Date.UTC(2024, 0, 15, 14, 0, 0),
      title: 'Afternoon Briefing',
      description: '',
    },
  ]);

  const [skyNews] = listIptvChannels(database, { sourceId, query: 'sky news', nowMs });
  assert.equal(skyNews.nowTitle, 'Sky News At Noon');
  assert.equal(skyNews.nextTitle, 'Afternoon Briefing');

  // A channel with no guide coverage still returns exactly one row.
  const [bbc] = listIptvChannels(database, { sourceId, query: 'bbc', nowMs });
  assert.equal(bbc.nowTitle, '');
  assert.equal(bbc.nextTitle, '');
  database.close();
});

test('a refresh replaces the channel list instead of merging into it', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  replaceVerifiedChannels(database, sourceId, [channel('Only Channel', { groupTitle: 'News' })]);

  assert.deepEqual(
    listIptvChannels(database, { sourceId }).map((row) => row.name),
    ['Only Channel'],
  );
  assert.deepEqual(listIptvGroups(database, sourceId), [{ name: 'News', channelCount: 1 }]);
  database.close();
});

test('channels without a passing health check stay hidden', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  replaceIptvChannels(database, sourceId, [
    channel('Verified Channel', { groupTitle: 'News' }),
    channel('Unchecked Channel', { groupTitle: 'Movies' }),
  ]);
  recordIptvStreamHealth(database, {
    streamUrl: channel('Verified Channel').streamUrl,
    status: 'ok',
    reason: '',
    failures: 0,
    hidden: false,
    checkedAt: 1,
    analyzedAt: 1,
  });

  assert.deepEqual(listIptvChannels(database, { sourceId }).map((row) => row.name), ['Verified Channel']);
  assert.equal(countIptvChannels(database, { sourceId }), 1);
  assert.deepEqual(listIptvGroups(database, sourceId), [{ name: 'News', channelCount: 1 }]);
  database.close();
});

test('a failed refresh keeps the last good timestamp and records the error', () => {
  const database = createDatabase();
  const sourceId = seed(database);

  const succeeded = recordIptvRefresh(database, sourceId, { channelCount: 5, programmeCount: 2 });
  assert.ok(succeeded && succeeded.refreshedAt > 0);
  assert.equal(succeeded.refreshError, '');

  const failed = recordIptvRefresh(database, sourceId, { error: 'The provider answered 502.' });
  assert.equal(failed?.refreshedAt, succeeded.refreshedAt);
  assert.equal(failed?.refreshError, 'The provider answered 502.');
  assert.equal(failed?.channelCount, 5);
  database.close();
});

test('removing a source clears its channels and guide entries', () => {
  const database = createDatabase();
  const sourceId = seed(database);
  replaceIptvProgrammes(database, sourceId, [{
    tvgId: 'sky.news',
    startMs: 1,
    endMs: 2,
    title: 'Anything',
    description: '',
  }]);

  assert.equal(deleteIptvSource(database, sourceId), true);
  assert.deepEqual(listIptvSources(database), []);
  assert.equal(countIptvChannels(database, { sourceId }), 0);
  const remainingProgrammes = database
    .prepare('SELECT COUNT(*) AS total FROM iptv_programmes WHERE source_id = ?')
    .get(sourceId) as { total: number };
  assert.equal(remainingProgrammes.total, 0);
  database.close();
});
