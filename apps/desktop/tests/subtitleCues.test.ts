import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanSubtitleCueText, parseVttCues } from '../src/components/VideoPlayer/subtitleCues.ts';

test('subtitle text drops formatting debris while retaining dialogue', () => {
  const cues = parseVttCues('1\n00:00:01,000 --> 00:00:03,000\n<i>I understand how you feel, Rudeus{*}-dono{*},</i>\n\n2\n00:00:04,000 --> 00:00:05,000\n{\\an8}Bread &amp; tea\\NThank you');
  assert.deepEqual(cues.map(cue => cue.text), [
    'I understand how you feel, Rudeus-dono,',
    'Bread & tea\nThank you',
  ]);
  assert.equal(cleanSubtitleCueText('♪ [door opens] {speaker}'), '♪ [door opens] {speaker}');
});
