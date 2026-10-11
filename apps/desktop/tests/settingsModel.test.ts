import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SETTINGS_SEARCH_INDEX,
  SETTINGS_GROUPS,
  buildAttentionItems,
  choicesWith,
  folderDisplayName,
  searchSettings,
} from '../src/pages/settingsModel.ts';

const ALL_PAGES = ['profiles', 'library', 'playback', 'plugins', 'live-tv', 'network', 'metadata', 'theme', 'about'] as const;

const baseAttention = {
  canManageLibrary: true,
  tmdbKey: 'key',
  folderStatuses: [],
  updateStatus: 'not-available',
  updateActionLabel: 'Check for updates',
  analysisState: 'idle',
};

test('settings v2 groups list every settings page exactly once', () => {
  const grouped = SETTINGS_GROUPS.flatMap((group) => group.pages);
  assert.deepEqual([...grouped].sort(), [...ALL_PAGES].sort());
});

test('settings search needs every word and ranks label matches first', () => {
  const results = searchSettings('pin', ALL_PAGES);
  assert.equal(results[0]?.label, 'Pairing PIN');
  assert.equal(results.some((entry) => entry.label === 'Intro and outro skipping'), false);
  assert.deepEqual(searchSettings('pin zebra', ALL_PAGES), []);
  assert.deepEqual(searchSettings('   ', ALL_PAGES), []);
});

test('settings search hides pages the profile cannot open', () => {
  const results = searchSettings('backup', ['profiles', 'playback', 'theme', 'about']);
  assert.equal(results.some((entry) => entry.section === 'library'), false);
});

test('settings search index only points at known pages', () => {
  for (const entry of SETTINGS_SEARCH_INDEX) assert.ok(ALL_PAGES.includes(entry.section), entry.label);
});

test('attention items cover updates, a missing TMDB key, folders and analysis errors', () => {
  const items = buildAttentionItems({
    ...baseAttention,
    tmdbKey: ' ',
    updateStatus: 'downloaded',
    latestVersion: '2.0.11',
    updateActionLabel: 'Restart to update',
    analysisState: 'error',
    analysisError: 'Helper crashed',
    folderStatuses: [
      { path: 'D:\\Media\\Movies', state: 'available', isNetworkLike: false, message: '' },
      { path: '\\\\nas\\media\\TV\\', state: 'unavailable', isNetworkLike: true, message: '' },
      { path: '/Volumes/Anime', state: 'degraded', isNetworkLike: false, message: 'Some files were unreadable.' },
    ],
  });
  assert.deepEqual(items.map((item) => item.id), ['update', 'tmdb', 'folder:\\\\nas\\media\\TV\\', 'folder:/Volumes/Anime', 'analysis']);
  assert.equal(items[0]?.title, 'Update ready to install');
  assert.equal(items[0]?.action, 'update');
  assert.equal(items[2]?.title, 'TV is unavailable');
  assert.match(items[2]?.description || '', /network share/);
  assert.equal(items[3]?.description, 'Some files were unreadable.');
  assert.equal(items[4]?.description, 'Helper crashed');
});

test('attention items for standard profiles only include updates', () => {
  const items = buildAttentionItems({ ...baseAttention, canManageLibrary: false, tmdbKey: '', updateStatus: 'available' });
  assert.deepEqual(items.map((item) => item.id), ['update']);
});

test('nothing needs attention when everything is set up', () => {
  assert.deepEqual(buildAttentionItems(baseAttention), []);
});

test('folder names come from the last path segment', () => {
  assert.equal(folderDisplayName('D:\\Media\\Old Shows\\'), 'Old Shows');
  assert.equal(folderDisplayName('/Volumes/media/Movies'), 'Movies');
});

test('quick setting choices keep a saved value that is not a preset', () => {
  assert.deepEqual(choicesWith([5, 10, 15, 30], 10), [5, 10, 15, 30]);
  assert.deepEqual(choicesWith([5, 10, 15, 30], 12), [5, 10, 12, 15, 30]);
});
