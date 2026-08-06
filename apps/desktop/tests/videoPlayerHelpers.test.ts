import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SUBTITLE_STYLE, SUBTITLE_STYLE_KEY } from '../src/components/VideoPlayer/constants.ts';
import {
  clampSubtitleDelay,
  hasReachedInitialResumePosition,
  initialHlsStartPosition,
  initialStreamOffset,
  isTimeBuffered,
  playbackProgressForExit,
  resolveInitialPlaybackPosition,
  transcodeSeekRestartOptions,
  isEditableShortcutTarget,
  isPlayerControlTarget,
  shouldRestartUnseekableDirectStream,
  shouldRestartTranscodedSubtitleStyle,
  shouldShowSubtitleOverlay,
  shouldUseNativeSubtitleTracks,
  subtitleTrackPlaybackAction,
} from '../src/components/VideoPlayer/playerControls.ts';
import {
  loadSubtitleStyle,
  saveSubtitleStyle,
} from '../src/components/VideoPlayer/subtitleStyleStorage.ts';

class MockElement {
  isContentEditable = false;
  private selectorMatch = false;

  constructor(selectorMatch = false) {
    this.selectorMatch = selectorMatch;
  }

  closest(): MockElement | null {
    return this.selectorMatch ? this : null;
  }
}

class MockInputElement extends MockElement {}
class MockTextAreaElement extends MockElement {}
class MockSelectElement extends MockElement {}

globalThis.Element = MockElement as unknown as typeof Element;
globalThis.HTMLElement = MockElement as unknown as typeof HTMLElement;
globalThis.HTMLInputElement = MockInputElement as unknown as typeof HTMLInputElement;
globalThis.HTMLTextAreaElement = MockTextAreaElement as unknown as typeof HTMLTextAreaElement;
globalThis.HTMLSelectElement = MockSelectElement as unknown as typeof HTMLSelectElement;

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

test('editable shortcut targets include inputs textareas selects and contenteditable nodes', () => {
  assert.equal(isEditableShortcutTarget(new MockInputElement() as unknown as EventTarget), true);
  assert.equal(isEditableShortcutTarget(new MockTextAreaElement() as unknown as EventTarget), true);
  assert.equal(isEditableShortcutTarget(new MockSelectElement() as unknown as EventTarget), true);

  const editable = new MockElement();
  editable.isContentEditable = true;
  assert.equal(isEditableShortcutTarget(editable as unknown as EventTarget), true);
});

test('player control targets include buttons sliders links and side panels', () => {
  assert.equal(isPlayerControlTarget(new MockElement(true) as unknown as EventTarget), true);
  assert.equal(isPlayerControlTarget(new MockElement(false) as unknown as EventTarget), false);
  assert.equal(isPlayerControlTarget(null), false);
});

test('subtitle delay clamps to the player sync range', () => {
  assert.equal(clampSubtitleDelay(90), 60);
  assert.equal(clampSubtitleDelay(-90), -60);
  assert.equal(clampSubtitleDelay(1.234), 1.23);
  assert.equal(clampSubtitleDelay(Number.NaN), 0);
});

test('subtitle style persists between player sessions', () => {
  storage.clear();
  const style = {
    ...DEFAULT_SUBTITLE_STYLE,
    delaySeconds: 1.25,
    position: 82,
    scale: 1.4,
    fontSize: 44,
    fontColor: '#ffeeaa',
    borderColor: '#111111',
    borderWidth: 5,
    backgroundColor: '#000000',
    backgroundEnabled: true,
  };

  saveSubtitleStyle(style);

  assert.deepEqual(loadSubtitleStyle(), style);
});

test('subtitle style loading falls back safely for invalid saved values', () => {
  storage.clear();
  localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify({
    delaySeconds: 999,
    position: -20,
    scale: 20,
    fontSize: 999,
    fontColor: 'red',
    borderWidth: -3,
  }));

  assert.deepEqual(loadSubtitleStyle(), {
    ...DEFAULT_SUBTITLE_STYLE,
    delaySeconds: 60,
    position: 0,
    scale: 2,
    fontSize: 96,
    borderWidth: 0,
  });
});

test('buffered seek checks tolerate tiny boundary drift without treating gaps as instant', () => {
  const buffered = {
    length: 2,
    start: (index: number) => [10, 40][index],
    end: (index: number) => [20, 50][index],
  } as TimeRanges;

  assert.equal(isTimeBuffered(buffered, 15), true);
  assert.equal(isTimeBuffered(buffered, 20.2), true);
  assert.equal(isTimeBuffered(buffered, 30), false);
  assert.equal(isTimeBuffered(buffered, 39.8), true);
  assert.equal(isTimeBuffered(buffered, 9.4), false);
  assert.equal(isTimeBuffered(null, 15), false);
});

test('forward-only shared streams restart through HLS when the target is not seekable', () => {
  const seekable = {
    length: 1,
    start: () => 0,
    end: () => 3,
  } as TimeRanges;

  assert.equal(shouldRestartUnseekableDirectStream({
    streamIsTranscoded: false,
    seekable,
    targetSeconds: 600,
  }), true);
  assert.equal(shouldRestartUnseekableDirectStream({
    streamIsTranscoded: false,
    seekable,
    targetSeconds: 2,
  }), false);
  assert.equal(shouldRestartUnseekableDirectStream({
    streamIsTranscoded: true,
    seekable,
    targetSeconds: 600,
  }), false);
});

test('continue-watching positions take precedence over a later progress-cache lookup', () => {
  assert.equal(resolveInitialPlaybackPosition(195, 0), 195);
  assert.equal(resolveInitialPlaybackPosition(undefined, 195), 195);
  assert.equal(resolveInitialPlaybackPosition(Number.NaN, 195), 195);
});

test('initial resume remains pending until the media element reaches the requested position', () => {
  assert.equal(hasReachedInitialResumePosition(0, 238), false);
  assert.equal(hasReachedInitialResumePosition(Number.NaN, 238), false);
  assert.equal(hasReachedInitialResumePosition(237.2, 238), true);
  assert.equal(hasReachedInitialResumePosition(0, 8), true);
});

test('windowed direct streams retain the requested absolute resume offset', () => {
  assert.equal(initialStreamOffset(238.9, true), 238);
  assert.equal(initialStreamOffset(238.9, false), 0);
  assert.equal(initialStreamOffset(Number.NaN, true), 0);
});

test('HLS starts at the resume position unless a windowed transcode already starts there', () => {
  assert.equal(initialHlsStartPosition({
    resumePosition: 195,
    streamIsTranscoded: false,
    streamIsSeekable: false,
  }), 195);
  assert.equal(initialHlsStartPosition({
    resumePosition: 195,
    streamIsTranscoded: true,
    streamIsSeekable: true,
  }), 195);
  assert.equal(initialHlsStartPosition({
    resumePosition: 195,
    streamIsTranscoded: true,
    streamIsSeekable: false,
  }), 0);
});

test('closing captures the latest absolute position for direct and windowed transcode playback', () => {
  assert.deepEqual(playbackProgressForExit({
    videoPosition: 198,
    snapshotPosition: 195,
    transcodeStartSeconds: 0,
    streamIsTranscoded: false,
    probedDuration: 1628,
    snapshotDuration: 1628,
    videoDuration: 1628,
  }), { position: 198, duration: 1628 });

  assert.deepEqual(playbackProgressForExit({
    videoPosition: 3,
    snapshotPosition: 195,
    transcodeStartSeconds: 195,
    streamIsTranscoded: true,
    probedDuration: 1628,
    snapshotDuration: 1628,
    videoDuration: 120,
  }), { position: 198, duration: 1628 });
});

test('transcoded seek restarts keep the current stream alive while preparing the next one', () => {
  assert.deepEqual(transcodeSeekRestartOptions({ forceRestart: false }), {
    force: true,
    allowNearEnd: true,
    showSeekingStatus: true,
    keepReadyDuringRestart: true,
    deferStopCurrent: true,
  });
  assert.deepEqual(transcodeSeekRestartOptions({ forceRestart: true }), {
    force: true,
    allowNearEnd: true,
    showSeekingStatus: true,
    keepReadyDuringRestart: false,
    deferStopCurrent: false,
  });
});

test('subtitle overlay shows only for selected text cues that are not burned into the transcoded stream', () => {
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: -1000,
    cueCount: 2,
    subtitleIsBurnedIn: false,
  }), true);
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: 3,
    cueCount: 2,
    subtitleIsBurnedIn: false,
  }), true);
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: 3,
    cueCount: 2,
    subtitleIsBurnedIn: true,
  }), false);
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: false,
    selectedSubtitleTrackIndex: -1000,
    cueCount: 2,
    subtitleIsBurnedIn: false,
  }), false);
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: -1,
    cueCount: 2,
    subtitleIsBurnedIn: false,
  }), false);
  assert.equal(shouldShowSubtitleOverlay({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: -1000,
    cueCount: 0,
    subtitleIsBurnedIn: false,
  }), false);
});

test('live subtitle style edits restart only burned-in transcoded subtitles', () => {
  assert.equal(shouldRestartTranscodedSubtitleStyle({
    subtitleIsBurnedIn: true,
  }), true);
  assert.equal(shouldRestartTranscodedSubtitleStyle({
    subtitleIsBurnedIn: false,
  }), false);
});

test('subtitle track changes preserve direct playback unless bitmap burn-in is required', () => {
  assert.equal(subtitleTrackPlaybackAction({
    selectedTrackIndex: 3,
    selectedSubtitleIsBitmap: false,
    activeSubtitleIsBurnedIn: false,
  }), 'overlay');
  assert.equal(subtitleTrackPlaybackAction({
    selectedTrackIndex: -1000,
    selectedSubtitleIsBitmap: false,
    activeSubtitleIsBurnedIn: false,
  }), 'overlay');
  assert.equal(subtitleTrackPlaybackAction({
    selectedTrackIndex: 5,
    selectedSubtitleIsBitmap: true,
    activeSubtitleIsBurnedIn: false,
  }), 'burn-in');
  assert.equal(subtitleTrackPlaybackAction({
    selectedTrackIndex: -1,
    selectedSubtitleIsBitmap: false,
    activeSubtitleIsBurnedIn: true,
  }), 'reload-source');
  assert.equal(subtitleTrackPlaybackAction({
    selectedTrackIndex: 7,
    selectedSubtitleIsBitmap: false,
    activeSubtitleIsBurnedIn: true,
  }), 'reload-source');
});

test('native subtitle tracks remain available as an external subtitle fallback', () => {
  assert.equal(shouldUseNativeSubtitleTracks({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: -1000,
    overlayVisible: false,
    subtitleIsBurnedIn: false,
  }), true);
  assert.equal(shouldUseNativeSubtitleTracks({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: -1000,
    overlayVisible: true,
    subtitleIsBurnedIn: false,
  }), false);
  assert.equal(shouldUseNativeSubtitleTracks({
    subtitlesEnabled: true,
    selectedSubtitleTrackIndex: 3,
    overlayVisible: false,
    subtitleIsBurnedIn: false,
  }), false);
  assert.equal(shouldUseNativeSubtitleTracks({
    subtitlesEnabled: false,
    selectedSubtitleTrackIndex: -1000,
    overlayVisible: false,
    subtitleIsBurnedIn: false,
  }), false);
});
