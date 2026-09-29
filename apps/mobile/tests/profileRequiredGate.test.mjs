import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('mandatory profile transitions tear down every media surface and native playback', () => {
  const start = appSource.indexOf('const resetMediaSessionForProfileChange');
  const end = appSource.indexOf('const detailItemCacheRef', start);
  const teardown = appSource.slice(start, end);

  assert.match(teardown, /mandatoryPlayerTeardownRef\.current\(\)/);
  assert.match(teardown, /setDetailItem\(null\)/);
  assert.match(teardown, /setPosterCandidateSheet\(null\)/);
  assert.match(teardown, /setMiniPlayerTarget\(null\)/);
  assert.match(teardown, /setPlayTarget\(null\)/);
  assert.match(teardown, /setPlaybackUrl\(null\)/);
  const transition = appSource.slice(appSource.indexOf('const enterProfilePicker'), end);
  assert.match(transition, /resetMediaSessionForProfileChange\(\)/);
  assert.match(transition, /mode !== 'voluntary'/);
});

test('the mandatory profile gate excludes detail, poster, mini-player, and player layers', () => {
  assert.match(appSource, /\{!showProfilePicker \? \(\s*<Fragment>\s*<DetailModal/);
  assert.match(appSource, /<PlayerModal[\s\S]*?<\/Fragment>\s*\) : null\}/);
  assert.match(appSource, /showStartupSplash && !showProfilePicker/);
});
