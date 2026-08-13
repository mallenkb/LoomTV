import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('mandatory profile transitions tear down every media surface and native playback', () => {
  const start = appSource.indexOf('const enterProfilePicker');
  const end = appSource.indexOf('const detailItemCacheRef', start);
  const transition = appSource.slice(start, end);

  assert.match(transition, /mandatoryPlayerTeardownRef\.current\(\)/);
  assert.match(transition, /setDetailItem\(null\)/);
  assert.match(transition, /setPosterCandidateSheet\(null\)/);
  assert.match(transition, /setMiniPlayerTarget\(null\)/);
  assert.match(transition, /setPlayTarget\(null\)/);
  assert.match(transition, /setPlaybackUrl\(null\)/);
});

test('the mandatory profile gate excludes detail, poster, mini-player, and player layers', () => {
  assert.match(appSource, /\{!showProfilePicker \? \(\s*<Fragment>\s*<DetailModal/);
  assert.match(appSource, /<PlayerModal[\s\S]*?<\/Fragment>\s*\) : null\}/);
  assert.match(appSource, /showStartupSplash && !showProfilePicker/);
});
