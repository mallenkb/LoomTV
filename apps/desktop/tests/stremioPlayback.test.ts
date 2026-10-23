import assert from 'node:assert/strict';
import test from 'node:test';
import { createStremioPlayback } from '../src/main/stremioPlayback.ts';
import { rewriteAddonHlsPlaylist } from '../src/main/addonHlsPlaylist.ts';
import { isAddonRelayUrl } from '../src/shared/addonPlaybackReference.ts';
import type { ManagedTorrent } from '../src/main/torrentEngine.ts';

function managedFixture() {
  let selectionRevision = 1;
  let now = 0;
  let releases = 0;
  const engine: ManagedTorrent = {
    result: { files: [{ index: 2, name: 'movie.mp4', size: 4096 }], suggestedIndex: 2,
      selectionReason: 'provider', notice: '', serviceVersion: 'fixture' },
    mediaUrl: index => `http://127.0.0.1:12345/private-engine-token/${index}`,
    open: async () => { throw new Error('This lifecycle fixture must not open network connections.'); },
    release: () => { releases++; },
    onFailure: () => { /* Failure delivery is exercised separately from lease ownership. */ },
  };
  const playback = createStremioPlayback({
    identity: () => ({ profileId: 'owner', selectionRevision }), revision: () => 'revision', port: () => 43210,
    now: () => now, prepareManagedTorrent: async () => engine,
  });
  const reference = playback.issue({ profileId: 'owner', selectionRevision, addonId: 'example', revision: 'revision',
    sourceKind: 'torrent', url: `torrent:${'a'.repeat(40)}`, torrent: { infoHash: 'a'.repeat(40), sources: [] } });
  return { playback, reference, releases: () => releases,
    switchProfile: () => { selectionRevision++; playback.revalidate(); },
    advance: (ms: number) => { now += ms; playback.revalidate(); } };
}

test('managed torrent ownership transfers to the selected grant and expires after its final lease', async () => {
  const f = managedFixture();
  try {
    await f.playback.prepareTorrent(f.reference, new AbortController().signal);
    const selected = f.playback.selectTorrent(f.reference, 2);
    f.playback.close(f.reference);
    assert.equal(f.releases(), 0);
    const first = f.playback.open(selected);
    const second = f.playback.open(selected);
    assert.ok(isAddonRelayUrl(first.url));
    assert.ok(!first.url.includes('private-engine-token'));
    first.release();
    assert.equal(f.releases(), 0);
    second.release(); second.release();
    assert.equal(f.playback.validate(selected), true);
    f.advance(30_000);
    assert.equal(f.releases(), 1);
    assert.equal(f.playback.validate(selected), false);
  } finally { f.playback.dispose(); }
});

test('abandoned managed torrent preparations expire without starting playback', async () => {
  const f = managedFixture();
  try {
    await f.playback.prepareTorrent(f.reference, new AbortController().signal);
    f.advance(5 * 60_000);
    assert.equal(f.releases(), 1);
    assert.throws(() => f.playback.selectTorrent(f.reference, 2));
  } finally { f.playback.dispose(); }
});

test('profile changes stop a managed torrent and revoke the native lease', async () => {
  const f = managedFixture();
  try {
    await f.playback.prepareTorrent(f.reference, new AbortController().signal);
    const selected = f.playback.selectTorrent(f.reference, 2);
    let revoked = false;
    f.playback.open(selected).onRevoke(() => { revoked = true; });
    f.switchProfile();
    assert.equal(f.releases(), 1);
    assert.equal(revoked, true);
    assert.equal(f.playback.validate(selected), false);
  } finally { f.playback.dispose(); }
});

function fixture() {
  let enabled = true;
  let selectionRevision = 1;
  let now = 0;
  const playback = createStremioPlayback({
    identity: () => ({ profileId: 'owner', selectionRevision }),
    revision: () => { if (!enabled) throw new Error('disabled'); return 'revision-1'; },
    port: () => 43210,
    now: () => now,
  });
  const issue = () => playback.issue({ profileId: 'owner', selectionRevision, addonId: 'example', revision: 'revision-1',
    url: 'https://provider.example/movie.mp4?secret=private', sourceKind: 'http' });
  return { playback, issue, disable: () => { enabled = false; playback.revalidate(); }, enable: () => { enabled = true; },
    switchProfile: () => { selectionRevision += 1; playback.revalidate(); }, advance: (ms: number) => { now += ms; playback.revalidate(); } };
}

test('grants stay revoked after disable and re-enable, including unopened sources', () => {
  const f = fixture();
  try {
    const reference = f.issue();
    assert.ok(!reference.includes('private'));
    f.disable(); f.enable();
    assert.throws(() => f.playback.open(reference));
  } finally { f.playback.dispose(); }
});

test('torrent descriptors cannot open before file selection or bypass the HTTPS boundary', async () => {
  const f = fixture();
  try {
    const source = { profileId: 'owner', selectionRevision: 1, addonId: 'example', revision: 'revision-1', sourceKind: 'torrent' };
    assert.throws(() => f.playback.issue({ ...source, url: 'http://127.0.0.1:11470/settings' }));
    const reference = f.playback.issue({ ...source, url: `torrent:${'a'.repeat(40)}`,
      torrent: { infoHash: 'a'.repeat(40), sources: [] } });
    assert.throws(() => f.playback.open(reference), /Choose a torrent file/);
    await assert.rejects(f.playback.openBrowser(reference), /native/);
    assert.throws(() => f.playback.selectTorrent(reference, 0));
    f.switchProfile();
    assert.equal(f.playback.validate(reference), false);
  } finally { f.playback.dispose(); }
});

test('browser sessions are reused and profile changes revoke native leases', () => {
  const f = fixture();
  try {
    const reference = f.issue();
    const browser = f.playback.open(reference, 'browser');
    for (let index = 0; index < 8; index += 1) assert.equal(f.playback.open(reference, 'browser').url, browser.url);
    assert.ok(isAddonRelayUrl(browser.url));
    let revoked = 0;
    f.playback.open(reference).onRevoke(() => { revoked += 1; });
    f.switchProfile();
    assert.equal(revoked, 1);
    assert.throws(() => f.playback.open(reference));
  } finally { f.playback.dispose(); }
});

test('idle expiry revokes playback and release is idempotent', () => {
  const f = fixture();
  try {
    let revoked = 0;
    const lease = f.playback.open(f.issue());
    lease.onRevoke(() => { revoked += 1; });
    f.advance(30 * 60 * 1000);
    assert.equal(revoked, 1);
    lease.release(); lease.release();
    assert.equal(revoked, 1);
  } finally { f.playback.dispose(); }
});

test('HLS keys, maps and variants become local grants relative to the final URL', () => {
  const resources: { url: string; kind: string }[] = [];
  const output = rewriteAddonHlsPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?secret=private"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8',
    'https://cdn.example/path/master.m3u8', (url, kind) => { resources.push({ url, kind }); return `/local/${resources.length}`; });
  assert.deepEqual(resources.map(item => item.kind), ['key', 'media', 'playlist']);
  assert.equal(resources[0].url, 'https://cdn.example/path/key?secret=private');
  assert.ok(!output.includes('secret'));
  assert.ok(output.includes('URI="/local/1"'));
  assert.ok(output.endsWith('/local/3'));
});

test('HLS rejects unsupported network-bearing tags, insecure resources and incomplete variants', () => {
  for (const body of [
    '#EXTM3U\nhttp://example.com/segment.ts',
    '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="https://example.com/steering"',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://example.com/key"',
  ]) assert.throws(() => rewriteAddonHlsPlaylist(body, 'https://provider.example/master.m3u8', () => '/local'));
});

test('selection validation detects expired grants without opening a playback session', () => {
  const f = fixture();
  try {
    const reference = f.issue();
    assert.equal(f.playback.validate(reference), true);
    f.advance(6 * 60 * 60 * 1000);
    assert.equal(f.playback.validate(reference), false);
    assert.equal(f.playback.validate('https://provider.example/movie.mp4'), false);
  } finally { f.playback.dispose(); }
});
