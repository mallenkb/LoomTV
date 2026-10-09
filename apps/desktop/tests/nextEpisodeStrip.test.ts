import assert from 'node:assert/strict';
import test from 'node:test';

import { nextEpisodeStripModel } from '../src/lib/nextEpisodeStrip.ts';
import type { LibraryEpisodeRef } from '../src/shared/desktopProtocol.ts';

const now = new Date(2026, 9, 9, 12);
const episode = (overrides: Partial<LibraryEpisodeRef> = {}): LibraryEpisodeRef => ({
  season: 2, episode: 1, title: 'Episode title', airDate: '2026-11-05', ...overrides,
});

test('a known title and date show the code, the title, and a day count', () => {
  const model = nextEpisodeStripModel(episode(), now);
  assert.ok(model);
  assert.equal(model.line, 'S02E01 · Episode title');
  assert.equal(model.daysUntil, 27);
  assert.equal(model.countdown, '27');
  assert.ok(model.airDate instanceof Date);
});

test('a missing title leaves the code alone, never a blank line', () => {
  for (const title of [undefined, '', '   ']) {
    const model = nextEpisodeStripModel(episode({ title: title as string }), now);
    assert.equal(model?.title, '');
    assert.equal(model?.line, 'S02E01');
  }
});

test('a generic title that only repeats the number is not shown', () => {
  assert.equal(nextEpisodeStripModel(episode({ title: 'Episode 1' }), now)?.line, 'S02E01');
  assert.equal(nextEpisodeStripModel(episode({ title: 'episode 12' }), now)?.line, 'S02E01');
});

test('placeholder titles such as TBA are not shown as the episode name', () => {
  for (const title of ['TBA', 'tbd', 'TBC', 'Untitled', 'unknown', 'N/A', '-']) {
    assert.equal(nextEpisodeStripModel(episode({ title }), now)?.line, 'S02E01', `title ${title}`);
  }
});

test('a missing or invalid air date keeps the strip with no count', () => {
  for (const airDate of [undefined, '', 'TBA', '2026-13-45']) {
    const model = nextEpisodeStripModel(episode({ airDate }), now);
    assert.ok(model, `strip should still render for ${String(airDate)}`);
    assert.equal(model.airDate, null);
    assert.equal(model.daysUntil, null);
    assert.equal(model.countdown, null);
    assert.equal(model.line, 'S02E01 · Episode title');
  }
});

test('both fields missing still gives the code', () => {
  const model = nextEpisodeStripModel(episode({ title: undefined, airDate: undefined }), now);
  assert.equal(model?.line, 'S02E01');
  assert.equal(model?.countdown, null);
});

test('today and tomorrow use their own words', () => {
  assert.equal(nextEpisodeStripModel(episode({ airDate: '2026-10-09' }), now)?.countdown, 'Today');
  assert.equal(nextEpisodeStripModel(episode({ airDate: '2026-10-10' }), now)?.countdown, 'Tomorrow');
});

test('a date already passed shows no count', () => {
  const model = nextEpisodeStripModel(episode({ airDate: '2026-10-01' }), now);
  assert.equal(model?.daysUntil, -8);
  assert.equal(model?.countdown, null);
});

test('no upcoming episode means no strip', () => {
  assert.equal(nextEpisodeStripModel(null, now), null);
  assert.equal(nextEpisodeStripModel(undefined, now), null);
});
