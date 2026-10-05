import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { animeSeasonMalIds, readShowSchedules, refreshShowSchedules, type ScheduleFetchers } from '../src/main/showSchedule.ts';
import { computeEpisodeUpdates } from '../src/main/libraryInsights.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';

const database = () => {
  const db = new BetterSqlite3(':memory:');
  db.exec('CREATE TABLE show_schedule_cache (cache_key TEXT PRIMARY KEY, episodes_json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  return db;
};
const anime = (id: string, providerIds: MediaItem['providerIds'], seasons: number[]) => ({
  id, type: 'anime', title: id, year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], cast: [],
  filePath: `/anime/${id}`, providerIds,
  episodeFiles: seasons.map((season) => ({ season, episode: 1, filePath: `/anime/${id}/S${season}E01.mkv` })),
}) as unknown as MediaItem;

test('anime seasons map to MAL IDs, with the show ID used only for season one', () => {
  assert.deepEqual(animeSeasonMalIds(anime('a', { malId: '64340' }, [1])), [{ season: 1, malId: 64340 }]);
  assert.deepEqual(animeSeasonMalIds(anime('b', { malId: '10', malIdBySeason: { 2: '20' } }, [1, 2, 3])), [{ season: 1, malId: 10 }, { season: 2, malId: 20 }]);
  assert.deepEqual(animeSeasonMalIds(anime('c', { malId: '10', malIdBySeason: { 1: '10' } }, [4])), [], 'season one\'s list is never used for another season');
  assert.deepEqual(animeSeasonMalIds(anime('d', { tmdbId: '1' }, [1])), []);
});

test('reading never fetches; stale anime is refreshed in one batched request, then cached', async () => {
  const db = database();
  const items = [anime('temppal', { malId: '64340' }, [1]), anime('aot', { malId: '16498', malIdBySeason: { 2: '25777' } }, [1, 2])];
  const first = readShowSchedules(db, items, { offline: false, now: 1_000 });
  assert.equal(first.schedules.size, 0);
  assert.equal(first.stale.length, 2);

  const requests: number[][] = [];
  const fetchers: ScheduleFetchers = {
    tv: async () => { throw new Error('not used'); },
    anime: async (ids) => {
      requests.push([...ids]);
      return new Map([
        [64340, [{ episode: 1, airDate: '2026-09-27' }, { episode: 2, airDate: '2026-10-04' }, { episode: 3, airDate: '2026-10-11' }]],
        [16498, [{ episode: 1, airDate: '2013-04-07' }]],
        [25777, [{ episode: 1, airDate: '2017-04-01' }]],
      ]);
    },
  };
  assert.equal(await refreshShowSchedules(db, first.stale, { now: 1_000, fetchers }), 2);
  assert.deepEqual(requests, [[64340, 16498, 25777]], 'one request for every anime');

  const second = readShowSchedules(db, items, { offline: false, now: 2_000 });
  assert.equal(second.stale.length, 0, 'fresh lists are not refetched');
  assert.deepEqual(second.schedules.get('aot')?.map((episode) => [episode.season, episode.number]), [[1, 1], [2, 1]]);
  assert.equal(await refreshShowSchedules(db, readShowSchedules(db, items, { offline: false, now: 13 * 60 * 60 * 1000 }).stale, { now: 3_000, fetchers }), 0, 'an unchanged list does not count as a change');

  // The next airing episode and the aired-but-missing episode both show.
  const updates = computeEpisodeUpdates([items[0]], {
    progress: {}, now: new Date('2026-10-06T12:00:00').getTime(), seen: new Map(), schedules: second.schedules,
  });
  assert.deepEqual(updates.shows[0].nextAirs, { season: 1, episode: 3, title: '', airDate: '2026-10-11' });
  assert.deepEqual(updates.shows[0].missing.map((episode) => episode.episode), [2]);
});

test('offline mode only reads the cache', () => {
  const { stale } = readShowSchedules(database(), [anime('temppal', { malId: '64340' }, [1])], { offline: true });
  assert.equal(stale.length, 0);
});
