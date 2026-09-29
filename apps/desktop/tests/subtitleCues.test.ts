import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAssCueText, cleanSubtitleCueText, isAssDialogueTrack, isAssSignsTrack, parseAssDialogueCues, parseVttCues } from '../src/components/VideoPlayer/subtitleCues.ts';

test('subtitle text drops formatting debris while retaining dialogue', () => {
  const cues = parseVttCues('1\n00:00:01,000 --> 00:00:03,000\n<i>I understand how you feel, Rudeus{*}-dono{*},</i>\n\n2\n00:00:04,000 --> 00:00:05,000\n{\\an8}Bread &amp; tea\\NThank you');
  assert.deepEqual(cues.map(cue => cue.text), [
    'I understand how you feel, Rudeus-dono,',
    'Bread & tea\nThank you',
  ]);
  assert.equal(cleanSubtitleCueText('♪ [door opens] {speaker}'), '♪ [door opens] {speaker}');
  assert.equal(
    cleanSubtitleCueText("He's amazingly amazing.{same way eris described ghislaine in 15}"),
    "He's amazingly amazing.",
  );
  assert.equal(cleanSubtitleCueText('Watch out! {door opens}'), 'Watch out! {door opens}');
});

test('ASS dialogue keeps the chosen wording and ignores inline comments and typeset signs', () => {
  const cues = parseAssDialogueCues([
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:04:57.36,0:04:59.11,Default,,0,0,0,,Rudeus{*}-dono{*}.',
    'Dialogue: 0,0:05:40.65,0:05:42.82,Default,,0,0,0,,Regarding {*}Eris-sama{*Lady Eris},',
    "Dialogue: 0,0:08:12.76,0:08:14.60,Default,,0,0,0,,He's amazingly amazing.{same way eris described ghislaine in 15}",
    'Dialogue: 0,0:09:00.00,0:09:02.00,Signs,,0,0,0,,{\\pos(10,20)}A shop sign',
    'Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,{\\i1}Look, Roxy{**-san}!{\\i0}\\N{*}Thank you{*Thanks}',
  ].join('\n'));
  assert.deepEqual(cues.map((cue) => cue.text), [
    'Rudeus-dono.',
    'Regarding Eris-sama,',
    "He's amazingly amazing.",
    'Look, Roxy!\nThank you',
  ]);
  assert.equal(cues[0]?.start, 297.36);
  assert.equal(cleanAssCueText('{\\an8}Watch out!\\hNow'), 'Watch out!\u00a0Now');
  assert.equal(cleanAssCueText('A\\nsoft break\\Nhard break'), 'A soft break\nhard break');
  assert.equal(isAssDialogueTrack('ass', 'Honorific@MTBB'), true);
  assert.equal(isAssSignsTrack('ass', 'Signs & Songs@EMBER'), true);
});
