import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/web-app.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}

function progressContext(api) {
  const context = vm.createContext({ api, selectedProfile: 'profile-1' });
  vm.runInContext(section('function normalizeProgress(', 'async function loadInvitations('), context);
  return context;
}

test('web progress reads the keyed server response and older list responses', () => {
  const { normalizeProgress } = progressContext(async () => ({}));
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(normalizeProgress({
    'movie-1': { position: 90, duration: 3600, watched: false, updatedAt: 20 },
    'movie-2': { position: 3500, duration: 3600, watched: true, updatedAt: 10 },
  })), [
    { mediaId: 'movie-1', position: 90, duration: 3600, watched: false, updatedAt: 20 },
    { mediaId: 'movie-2', position: 3500, duration: 3600, watched: true, updatedAt: 10 },
  ]);
  assert.deepEqual(plain(normalizeProgress([{ mediaId: 'movie-3', position: 5, duration: 60, watched: false, updatedAt: 1 }])),
    [{ mediaId: 'movie-3', position: 5, duration: 60, watched: false, updatedAt: 1 }]);
  assert.deepEqual(plain(normalizeProgress(null)), []);
  assert.deepEqual(plain(normalizeProgress([{ position: 5 }, null])), []);
});

test('web progress reports a failed load instead of an empty history', async () => {
  const failing = progressContext(async () => { throw Object.assign(new Error('offline'), { code: 'server_unreachable' }); });
  assert.equal(await failing.loadProgress(), null);

  const loaded = progressContext(async () => ({ progress: { 'movie-1': { position: 90, duration: 3600, watched: false, updatedAt: 20 } } }));
  assert.equal((await loaded.loadProgress())[0].mediaId, 'movie-1');
});
