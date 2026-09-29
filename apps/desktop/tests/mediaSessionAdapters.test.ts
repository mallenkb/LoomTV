import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMediaSessionDiscontinuity,
  normalizeMediaSessionCommand,
  normalizeMediaSessionSnapshot,
  resolveSeekPosition,
  type MediaSessionSnapshot,
} from '../src/shared/mediaControlProtocol.ts';
import {
  MACOS_COMMAND_BINDINGS,
  enabledMacOsCommands,
} from '../src/main/mediaControl/macosMediaPlayerAdapter.ts';
import {
  commandForSmtcButton,
  playbackStatusForSnapshot,
  secondsToTicks,
  smtcCapabilities,
  ticksToSeconds,
} from '../src/main/mediaControl/windowsSmtcAdapter.ts';
import {
  commandForMprisMethod,
  microsecondsToSeconds,
  mprisCapabilities,
  mprisPlaybackStatus,
  secondsToMicroseconds,
  trackIdForSession,
} from '../src/main/mediaControl/linuxMprisAdapter.ts';
import { acceptsDelegateInterface, guidFromBytes, guidToBuffer } from '../src/main/mediaControl/winrt.ts';
import { supportedMediaSessionCommands } from '../src/components/VideoPlayer/mediaControlState.ts';
import { isStageableArtworkUrl } from '../src/main/mediaControl/artworkStaging.ts';

function snapshot(overrides: Partial<MediaSessionSnapshot> = {}): MediaSessionSnapshot {
  return normalizeMediaSessionSnapshot({
    sessionId: '/library/show/s01e01.mkv',
    state: 'playing',
    positionSeconds: 60,
    durationSeconds: 1400,
    rate: 1,
    supportedCommands: [
      'play',
      'pause',
      'toggle',
      'stop',
      'seekRelative',
      'seekAbsolute',
      'previousItem',
      'nextItem',
      'setRate',
    ],
    skipForwardSeconds: 30,
    skipBackSeconds: 10,
    title: 'The First Episode',
    seriesTitle: 'A Show',
    season: 1,
    episode: 1,
    queueIndex: 1,
    queueCount: 10,
    engine: 'libvlc',
    engineSessionId: 'libvlc-session-1',
    ...overrides,
  });
}

// ─── Shared contract ─────────────────────────────────────────────────────────

test('snapshot normalization clamps everything a platform API would reject', () => {
  const normalized = normalizeMediaSessionSnapshot({
    sessionId: '   ',
    state: 'nonsense',
    positionSeconds: Number.NaN,
    durationSeconds: -5,
    rate: 0,
    supportedCommands: ['play', 'not-a-command', 'nextItem'],
    skipForwardSeconds: -1,
    skipBackSeconds: 0,
    title: '   Spaced\n   Title   ',
    queueIndex: -3,
    queueCount: 4.7,
    engine: 'quicktime',
  });

  assert.equal(normalized.sessionId, 'loomtv-player');
  assert.equal(normalized.state, 'paused');
  assert.equal(normalized.positionSeconds, 0);
  assert.equal(normalized.durationSeconds, 0);
  assert.equal(normalized.rate, 1);
  assert.deepEqual(normalized.supportedCommands, ['play', 'nextItem']);
  assert.equal(normalized.skipForwardSeconds, 10);
  assert.equal(normalized.skipBackSeconds, 10);
  assert.equal(normalized.title, 'Spaced Title');
  assert.equal(normalized.queueIndex, 0);
  assert.equal(normalized.queueCount, 4);
  assert.equal(normalized.engine, 'chromium');
});

test('position never exceeds the duration it belongs to', () => {
  const normalized = normalizeMediaSessionSnapshot({
    durationSeconds: 100,
    positionSeconds: 900,
  });
  assert.equal(normalized.positionSeconds, 100);
});

test('a malformed command is dropped rather than reaching the player', () => {
  assert.equal(normalizeMediaSessionCommand({ type: 'explode' }), null);
  assert.equal(normalizeMediaSessionCommand({ type: 'seekAbsolute' }), null);
  assert.equal(normalizeMediaSessionCommand({ type: 'seekAbsolute', positionSeconds: -1 }), null);
  assert.equal(normalizeMediaSessionCommand({ type: 'seekRelative', offsetSeconds: 0 }), null);
  assert.equal(normalizeMediaSessionCommand({ type: 'setRate', rate: 0 }), null);
  assert.deepEqual(normalizeMediaSessionCommand({ type: 'toggle' }), { type: 'toggle' });
  assert.deepEqual(
    normalizeMediaSessionCommand({ type: 'seekRelative', offsetSeconds: -15 }),
    { type: 'seekRelative', offsetSeconds: -15 },
  );
});

test('seek resolution uses the item bounds and needs a known duration', () => {
  const playing = snapshot();
  assert.equal(resolveSeekPosition(playing, { type: 'seekRelative', offsetSeconds: 30 }), 90);
  assert.equal(resolveSeekPosition(playing, { type: 'seekRelative', offsetSeconds: -600 }), 0);
  assert.equal(resolveSeekPosition(playing, { type: 'seekAbsolute', positionSeconds: 99_999 }), 1400);
  assert.equal(resolveSeekPosition(playing, { type: 'play' }), null);

  const live = snapshot({ durationSeconds: 0, positionSeconds: 0 });
  assert.equal(resolveSeekPosition(live, { type: 'seekAbsolute', positionSeconds: 10 }), null);
});

test('discontinuity detection ignores playback drift but catches every real change', () => {
  const base = snapshot();
  assert.equal(isMediaSessionDiscontinuity(null, base), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ positionSeconds: 61 })), false);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ positionSeconds: 600 })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ state: 'paused' })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ rate: 1.5 })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ sessionId: '/other.mkv' })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ episode: 2 })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ supportedCommands: ['play'] })), true);
  assert.equal(isMediaSessionDiscontinuity(base, snapshot({ skipForwardSeconds: 15 })), true);
});

test('a paused session treats any position change as a seek', () => {
  const paused = snapshot({ state: 'paused' });
  assert.equal(isMediaSessionDiscontinuity(paused, snapshot({ state: 'paused', positionSeconds: 60.5 })), true);
  assert.equal(isMediaSessionDiscontinuity(paused, snapshot({ state: 'paused' })), false);
});

// ─── Renderer capability mapping ─────────────────────────────────────────────

test('the player advertises only the commands it can actually service', () => {
  const base = {
    sessionId: 'a',
    state: 'playing' as const,
    positionSeconds: 0,
    durationSeconds: 1400,
    rate: 1,
    title: 'Title',
    queueIndex: 1,
    queueCount: 3,
    canPreviousItem: true,
    canNextItem: true,
    skipForwardSeconds: 30,
    skipBackSeconds: 10,
    engine: 'libvlc' as const,
  };

  assert.deepEqual(supportedMediaSessionCommands(base), [
    'play', 'pause', 'toggle', 'stop', 'setRate', 'seekRelative', 'seekAbsolute', 'previousItem', 'nextItem',
  ]);

  // A movie has no queue, and a stream with no duration cannot be seeked.
  assert.deepEqual(
    supportedMediaSessionCommands({ ...base, canPreviousItem: false, canNextItem: false, durationSeconds: 0 }),
    ['play', 'pause', 'toggle', 'stop', 'setRate'],
  );
});

// ─── macOS MediaPlayer ───────────────────────────────────────────────────────

test('macOS registers discrete play, pause, and toggle', () => {
  const commands = MACOS_COMMAND_BINDINGS.map((binding) => binding.command);
  assert.ok(commands.includes('playCommand'));
  assert.ok(commands.includes('pauseCommand'));
  assert.ok(commands.includes('togglePlayPauseCommand'));
  assert.ok(commands.includes('changePlaybackPositionCommand'));
  assert.ok(commands.includes('skipForwardCommand'));
  assert.ok(commands.includes('skipBackwardCommand'));
});

test('macOS enables only the commands the snapshot supports', () => {
  const full = enabledMacOsCommands(snapshot());
  assert.ok(full.includes('nextTrackCommand'));
  assert.ok(full.includes('changePlaybackPositionCommand'));

  const movie = enabledMacOsCommands(snapshot({
    supportedCommands: ['play', 'pause', 'toggle', 'stop', 'setRate'],
  }));
  assert.ok(!movie.includes('nextTrackCommand'));
  assert.ok(!movie.includes('previousTrackCommand'));
  assert.ok(!movie.includes('skipForwardCommand'));
  assert.ok(movie.includes('playCommand'));
});

test('a macOS skip command falls back to the user interval when the event has none', () => {
  const forward = MACOS_COMMAND_BINDINGS.find((binding) => binding.command === 'skipForwardCommand');
  const backward = MACOS_COMMAND_BINDINGS.find((binding) => binding.command === 'skipBackwardCommand');
  const noInterval = { positionTime: () => Number.NaN, interval: () => 0, playbackRate: () => Number.NaN };
  const withInterval = { positionTime: () => Number.NaN, interval: () => 45, playbackRate: () => Number.NaN };

  assert.deepEqual(forward?.build(snapshot(), noInterval), { type: 'seekRelative', offsetSeconds: 30 });
  assert.deepEqual(backward?.build(snapshot(), noInterval), { type: 'seekRelative', offsetSeconds: -10 });
  // A platform that names its own interval wins for that command.
  assert.deepEqual(forward?.build(snapshot(), withInterval), { type: 'seekRelative', offsetSeconds: 45 });
});

// ─── Windows SMTC ────────────────────────────────────────────────────────────

test('SMTC buttons map to the contract, with skip intervals for seek buttons', () => {
  const current = snapshot();
  assert.deepEqual(commandForSmtcButton(0, current), { type: 'play' });
  assert.deepEqual(commandForSmtcButton(1, current), { type: 'pause' });
  assert.deepEqual(commandForSmtcButton(2, current), { type: 'stop' });
  assert.deepEqual(commandForSmtcButton(6, current), { type: 'nextItem' });
  assert.deepEqual(commandForSmtcButton(7, current), { type: 'previousItem' });
  assert.deepEqual(commandForSmtcButton(4, current), { type: 'seekRelative', offsetSeconds: 30 });
  assert.deepEqual(commandForSmtcButton(5, current), { type: 'seekRelative', offsetSeconds: -10 });
  // Record has no meaning for a media library.
  assert.equal(commandForSmtcButton(3, current), null);
});

test('SMTC capability flags follow the snapshot', () => {
  assert.deepEqual(smtcCapabilities(snapshot()), {
    play: true, pause: true, stop: true, next: true, previous: true, fastForward: true, rewind: true,
  });
  assert.deepEqual(
    smtcCapabilities(snapshot({ supportedCommands: ['play', 'pause', 'toggle'] })),
    { play: true, pause: true, stop: false, next: false, previous: false, fastForward: false, rewind: false },
  );
});

test('SMTC playback status follows the session state', () => {
  assert.equal(playbackStatusForSnapshot(snapshot()), 3);
  assert.equal(playbackStatusForSnapshot(snapshot({ state: 'paused' })), 4);
  assert.equal(playbackStatusForSnapshot(snapshot({ state: 'stopped' })), 2);
});

test('WinRT TimeSpan conversion round-trips seconds through 100-nanosecond ticks', () => {
  assert.equal(secondsToTicks(1), 10_000_000n);
  assert.equal(secondsToTicks(0), 0n);
  assert.equal(secondsToTicks(-5), 0n);
  assert.equal(secondsToTicks(Number.NaN), 0n);
  assert.equal(ticksToSeconds(secondsToTicks(1234.5)), 1234.5);
});

test('a GUID packs into the mixed-endian COM layout and reads back unchanged', () => {
  const iid = 'ddb0472d-c911-4a1f-86d9-dc3d71a95f5a';
  const packed = guidToBuffer(iid);
  assert.equal(packed.length, 16);
  // Data1 is little-endian, so the first byte is the last byte of "ddb0472d".
  assert.equal(packed[0], 0x2d);
  assert.equal(packed[3], 0xdd);
  // Data4 keeps its byte order.
  assert.equal(packed[8], 0x86);
  assert.equal(guidFromBytes(packed), iid);
  assert.throws(() => guidToBuffer('not-a-guid'));
});

test('the SMTC delegate refuses the interfaces that would move it off its apartment', () => {
  // IUnknown and the parameterized handler interface are accepted.
  assert.equal(acceptsDelegateInterface('00000000-0000-0000-C000-000000000046'), true);
  assert.equal(acceptsDelegateInterface('9de1c534-6ae1-11e0-84e1-18a905bcc53f'), true);
  // Claiming agility would let WinRT call back on a thread koffi cannot serve.
  assert.equal(acceptsDelegateInterface('94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90'), false);
  assert.equal(acceptsDelegateInterface('00000003-0000-0000-c000-000000000046'), false);
  assert.equal(acceptsDelegateInterface('af86e2e0-b12d-4c6a-9c5a-d7aa65101e90'), false);
});

// ─── Linux MPRIS ─────────────────────────────────────────────────────────────

test('MPRIS methods map to the contract', () => {
  assert.deepEqual(commandForMprisMethod('Play', []), { type: 'play' });
  assert.deepEqual(commandForMprisMethod('Pause', []), { type: 'pause' });
  assert.deepEqual(commandForMprisMethod('PlayPause', []), { type: 'toggle' });
  assert.deepEqual(commandForMprisMethod('Stop', []), { type: 'stop' });
  assert.deepEqual(commandForMprisMethod('Next', []), { type: 'nextItem' });
  assert.deepEqual(commandForMprisMethod('Previous', []), { type: 'previousItem' });
  assert.equal(commandForMprisMethod('Unknown', []), null);
});

test('MPRIS Seek is relative microseconds and SetPosition is absolute', () => {
  assert.deepEqual(
    commandForMprisMethod('Seek', [30_000_000n]),
    { type: 'seekRelative', offsetSeconds: 30 },
  );
  assert.deepEqual(
    commandForMprisMethod('Seek', [-10_000_000n]),
    { type: 'seekRelative', offsetSeconds: -10 },
  );
  assert.deepEqual(
    commandForMprisMethod('SetPosition', ['/track/1', 90_000_000n]),
    { type: 'seekAbsolute', positionSeconds: 90 },
  );
  // A client sending the wrong argument type must not move the player.
  assert.equal(commandForMprisMethod('Seek', ['30']), null);
  assert.equal(commandForMprisMethod('Seek', [0n]), null);
});

test('MPRIS time conversion round-trips through microseconds', () => {
  assert.equal(secondsToMicroseconds(1.5), 1_500_000n);
  assert.equal(secondsToMicroseconds(-1), 0n);
  assert.equal(microsecondsToSeconds(secondsToMicroseconds(1400)), 1400);
});

test('MPRIS playback status and capabilities follow the snapshot', () => {
  assert.equal(mprisPlaybackStatus(snapshot()), 'Playing');
  assert.equal(mprisPlaybackStatus(snapshot({ state: 'paused' })), 'Paused');
  assert.equal(mprisPlaybackStatus(snapshot({ state: 'stopped' })), 'Stopped');

  assert.deepEqual(mprisCapabilities(snapshot()), {
    canGoNext: true, canGoPrevious: true, canPlay: true, canPause: true, canSeek: true, canControl: true,
  });
  assert.deepEqual(mprisCapabilities(snapshot({ supportedCommands: ['play'] })), {
    canGoNext: false, canGoPrevious: false, canPlay: true, canPause: false, canSeek: false, canControl: true,
  });
});

test('the MPRIS track id is a valid object path that changes with the item', () => {
  const first = trackIdForSession('/library/show/s01e01.mkv');
  const second = trackIdForSession('/library/show/s01e02.mkv');
  assert.match(first, /^\/org\/mpris\/MediaPlayer2\/loomtv\/track\/[0-9a-f]+$/);
  assert.notEqual(first, second);
  assert.match(trackIdForSession(''), /^\/org\/mpris\/MediaPlayer2\/loomtv\/track\/0$/);
});

// ─── Artwork ─────────────────────────────────────────────────────────────────

test('artwork is read only from local files and LoomTV\'s own loopback server', () => {
  assert.equal(isStageableArtworkUrl('file:///Users/me/poster.jpg'), true);
  assert.equal(isStageableArtworkUrl('http://127.0.0.1:8080/artwork/poster.jpg'), true);
  assert.equal(isStageableArtworkUrl('http://localhost:8080/artwork/poster.jpg'), true);
  // A media command must never become a way to make the main process fetch a
  // remote address.
  assert.equal(isStageableArtworkUrl('http://example.com/poster.jpg'), false);
  assert.equal(isStageableArtworkUrl('https://image.tmdb.org/poster.jpg'), false);
  assert.equal(isStageableArtworkUrl('loomtv://artwork/poster.jpg'), false);
  assert.equal(isStageableArtworkUrl('not a url'), false);
});
