import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionConfigHash } from '../src/main/skipSegments/configHash.ts';
import type { SkipAnalysisSettings } from '../src/shared/desktopProtocol.ts';

const settings = (): SkipAnalysisSettings => ({
  enabled: true, analyzeNewMedia: true,
  enabledTypes: { intro: true, recap: true, credits: true, preview: true },
  promptTypes: { intro: true, recap: true, credits: true, preview: false },
  durationLimits: { intro: { minSeconds: 15, maxSeconds: 180 }, recap: { minSeconds: 15, maxSeconds: 120 }, credits: { minSeconds: 15, maxSeconds: 300 }, preview: { minSeconds: 15, maxSeconds: 120 }, movieCredits: { minSeconds: 15, maxSeconds: 900 } },
  suppressFirstEpisodeIntro: false, analyzeSpecials: false,
  exclusions: { seriesIds: [], movieIds: [], seasons: [], paths: [] }, seasonOverrides: {},
});

test('selection hash changes for marker-affecting duration limits', () => {
  const original = settings();
  const changed = settings();
  changed.durationLimits.intro.maxSeconds = 170;
  assert.notEqual(selectionConfigHash(original), selectionConfigHash(changed));
});

test('selection hash ignores playback-prompt preferences', () => {
  const original = settings();
  const changed = settings();
  changed.promptTypes.preview = true;
  assert.equal(selectionConfigHash(original), selectionConfigHash(changed));
});

test('selection hash treats exclusion lists as semantic sets', () => {
  const left = settings();
  const right = settings();
  left.exclusions.seriesIds = ['series-b', 'series-a'];
  right.exclusions.seriesIds = ['series-a', 'series-b'];
  assert.equal(selectionConfigHash(left), selectionConfigHash(right));
});
