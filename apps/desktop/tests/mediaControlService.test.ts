import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMediaSessionController,
  type MediaSessionAdapter,
  type MediaSessionAdapterCandidate,
  type MediaSessionEngineDispatcher,
  type MediaSessionOwner,
} from '../src/main/mediaControl/service.ts';
import type {
  MediaSessionAdapterKind,
  MediaSessionCommand,
  MediaSessionSnapshot,
} from '../src/shared/mediaControlProtocol.ts';

type FakeAdapter = MediaSessionAdapter & {
  published: MediaSessionSnapshot[];
  starts: number;
  clears: number;
  send: (command: MediaSessionCommand) => void;
};

function fakeAdapter(options: {
  kind?: MediaSessionAdapterKind;
  failOnStart?: string;
} = {}): FakeAdapter {
  let onCommand: ((command: MediaSessionCommand) => void) | null = null;
  const adapter: FakeAdapter = {
    kind: options.kind ?? 'macos-mediaplayer',
    published: [],
    starts: 0,
    clears: 0,
    start(handlers) {
      adapter.starts += 1;
      if (options.failOnStart) throw new Error(options.failOnStart);
      onCommand = handlers.onCommand;
    },
    publish(snapshot) {
      adapter.published.push(snapshot);
    },
    clear() {
      adapter.clears += 1;
      onCommand = null;
    },
    send(command) {
      onCommand?.(command);
    },
  };
  return adapter;
}

function candidate(adapter: MediaSessionAdapter): MediaSessionAdapterCandidate {
  return { kind: adapter.kind, create: () => adapter };
}

type Notification = { command: MediaSessionCommand; handledInMain: boolean };

function owner(
  id: number,
  received: Notification[],
  alive = { value: true },
): MediaSessionOwner {
  return {
    id,
    isAlive: () => alive.value,
    notify: (command, handledInMain) => received.push({ command, handledInMain }),
  };
}

type EngineCall = { engine: string; sessionId: string; action: string; value: unknown };

function recordingEngine(calls: EngineCall[], succeeds = true): MediaSessionEngineDispatcher {
  return {
    setPaused: (engine, sessionId, paused) => {
      calls.push({ engine, sessionId, action: 'setPaused', value: paused });
      return succeeds;
    },
    seek: (engine, sessionId, positionSeconds) => {
      calls.push({ engine, sessionId, action: 'seek', value: positionSeconds });
      return succeeds;
    },
    setRate: (engine, sessionId, rate) => {
      calls.push({ engine, sessionId, action: 'setRate', value: rate });
      return succeeds;
    },
  };
}

const ALL_COMMANDS = [
  'play',
  'pause',
  'toggle',
  'stop',
  'seekRelative',
  'seekAbsolute',
  'previousItem',
  'nextItem',
  'setRate',
];

const libvlcPlaying = {
  sessionId: '/library/show/s01e01.mkv',
  state: 'playing',
  positionSeconds: 60,
  durationSeconds: 1400,
  rate: 1,
  supportedCommands: ALL_COMMANDS,
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
};

const chromiumPlaying = { ...libvlcPlaying, engine: 'chromium', engineSessionId: undefined };

test('a platform command reaches the running engine without a renderer round trip', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, received), libvlcPlaying);
  adapter.send({ type: 'pause' });

  assert.deepEqual(calls, [{
    engine: 'libvlc',
    sessionId: 'libvlc-session-1',
    action: 'setPaused',
    value: true,
  }]);
  // The renderer is told what happened so its own pause intent stays in step,
  // but it must not run the transport a second time.
  assert.deepEqual(received, [{ command: { type: 'pause' }, handledInMain: true }]);
});

test('toggle pauses a playing session and resumes a paused one', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, []), libvlcPlaying);
  adapter.send({ type: 'toggle' });
  controller.publish(owner(1, []), { ...libvlcPlaying, state: 'paused' });
  adapter.send({ type: 'toggle' });

  assert.deepEqual(calls.map((call) => call.value), [true, false]);
});

test('a relative seek resolves against the live position and clamps to the item', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, []), libvlcPlaying);
  adapter.send({ type: 'seekRelative', offsetSeconds: 30 });
  adapter.send({ type: 'seekRelative', offsetSeconds: -600 });

  assert.deepEqual(calls.map((call) => call.value), [90, 0]);
});

test('Chromium playback is routed to the renderer instead of the main process', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, received), chromiumPlaying);
  adapter.send({ type: 'play' });

  assert.deepEqual(calls, []);
  assert.deepEqual(received, [{ command: { type: 'play' }, handledInMain: false }]);
});

test('an engine that refuses the command hands it to the renderer', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls, false),
  });

  controller.publish(owner(1, received), libvlcPlaying);
  adapter.send({ type: 'pause' });

  assert.equal(calls.length, 1);
  assert.deepEqual(received, [{ command: { type: 'pause' }, handledInMain: false }]);
});

test('stop, next, and previous always go to the renderer', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, received), libvlcPlaying);
  adapter.send({ type: 'stop' });
  adapter.send({ type: 'nextItem' });
  adapter.send({ type: 'previousItem' });

  assert.deepEqual(calls, []);
  assert.deepEqual(received.map((entry) => entry.command.type), ['stop', 'nextItem', 'previousItem']);
  assert.ok(received.every((entry) => entry.handledInMain === false));
});

test('a command the snapshot does not support is dropped', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(1, received), {
    ...libvlcPlaying,
    supportedCommands: ['play', 'pause', 'toggle'],
  });
  adapter.send({ type: 'nextItem' });
  adapter.send({ type: 'seekAbsolute', positionSeconds: 10 });

  assert.deepEqual(received, []);
  assert.deepEqual(calls, []);
});

test('only one owner holds the session and a newer player replaces the older one', () => {
  const adapter = fakeAdapter();
  const first: Notification[] = [];
  const second: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(1, first), libvlcPlaying);
  controller.publish(owner(2, second), { ...libvlcPlaying, sessionId: '/library/movie.mkv' });

  assert.equal(controller.ownerId(), 2);
  adapter.send({ type: 'nextItem' });
  assert.deepEqual(first, []);
  assert.equal(second.length, 1);

  // The platform session stays up across the handover: one continuous session
  // rather than a release and a fresh registration.
  assert.equal(adapter.starts, 1);
  assert.equal(adapter.clears, 0);
});

test('a paused player keeps the session so play still resumes it', () => {
  const adapter = fakeAdapter();
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(3, received), libvlcPlaying);
  controller.publish(owner(3, received), { ...libvlcPlaying, state: 'paused' });

  assert.equal(controller.ownerId(), 3);
  assert.equal(adapter.clears, 0);
  assert.equal(adapter.published.at(-1)?.state, 'paused');

  adapter.send({ type: 'play' });
  assert.equal(received.at(-1)?.command.type, 'play');
});

test('a stopped snapshot releases the session without closing the player', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(4, []), libvlcPlaying);
  controller.publish(owner(4, []), { ...libvlcPlaying, state: 'stopped' });

  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.clears, 1);
  assert.equal(controller.diagnostics().active, false);
});

test('a released session is not reclaimed by a merely paused player', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(5, []), libvlcPlaying);
  controller.publish(owner(5, []), { ...libvlcPlaying, state: 'stopped' });

  // Another application may now hold the media slot. LoomTV keeps reporting a
  // paused player without fighting for it back.
  controller.publish(owner(5, []), { ...libvlcPlaying, state: 'paused' });
  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.starts, 1);

  // Playing again is what takes the session back.
  controller.publish(owner(5, []), libvlcPlaying);
  assert.equal(controller.ownerId(), 5);
  assert.equal(adapter.starts, 2);
});

test('release clears the platform session and the renderer that owned it', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(6, []), libvlcPlaying);
  assert.equal(controller.release(6), true);
  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.clears, 1);

  // A renderer that never owned the session cannot release it.
  controller.publish(owner(7, []), libvlcPlaying);
  assert.equal(controller.release(999), false);
  assert.equal(controller.ownerId(), 7);
});

test('a destroyed renderer releases the session instead of receiving commands', () => {
  const adapter = fakeAdapter();
  const received: Notification[] = [];
  const alive = { value: true };
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(8, received, alive), libvlcPlaying);
  alive.value = false;
  adapter.send({ type: 'pause' });

  assert.deepEqual(received, []);
  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.clears, 1);
});

test('releaseAll tears the session down for app shutdown and allows a later claim', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(9, []), libvlcPlaying);
  controller.releaseAll();
  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.clears, 1);

  controller.publish(owner(10, []), libvlcPlaying);
  assert.equal(controller.ownerId(), 10);
  assert.equal(adapter.starts, 2);
});

test('an adapter that cannot start leaves playback alone and reports why', () => {
  const adapter = fakeAdapter({ kind: 'linux-mpris', failOnStart: 'No D-Bus session bus is available.' });
  const warnings: string[] = [];
  const received: Notification[] = [];
  const controller = createMediaSessionController({
    platform: 'linux',
    candidates: () => [candidate(adapter)],
    logWarning: (message) => warnings.push(message),
  });

  const diagnostics = controller.publish(owner(11, received), libvlcPlaying);
  assert.equal(diagnostics.active, false);
  assert.equal(diagnostics.adapter, 'unsupported');
  assert.match(String(diagnostics.reason), /No D-Bus session bus/);
  assert.equal(warnings.length, 1);
  // Nothing was delivered to the player, and nothing threw.
  assert.deepEqual(received, []);
});

test('a platform with no adapter reports itself as unsupported', () => {
  const controller = createMediaSessionController({
    platform: 'freebsd',
    candidates: () => [],
  });

  const diagnostics = controller.publish(owner(12, []), libvlcPlaying);
  assert.equal(diagnostics.active, false);
  assert.equal(diagnostics.adapter, 'unsupported');
  assert.match(String(diagnostics.reason), /freebsd/);
});

test('an adapter that throws while publishing does not break the session', () => {
  const adapter = fakeAdapter();
  adapter.publish = () => { throw new Error('publish failed'); };
  const warnings: string[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    logWarning: (message) => warnings.push(message),
  });

  assert.doesNotThrow(() => controller.publish(owner(13, []), libvlcPlaying));
  assert.equal(controller.ownerId(), 13);
  assert.ok(warnings.some((message) => message.includes('Publishing the media session snapshot failed')));
});

test('snapshots publish on discontinuity, not on every playback tick', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
  });

  controller.publish(owner(14, []), libvlcPlaying);
  assert.equal(adapter.published.length, 1);

  // Position creeping forward during playback is interpolated by the platform.
  controller.publish(owner(14, []), { ...libvlcPlaying, positionSeconds: 61 });
  controller.publish(owner(14, []), { ...libvlcPlaying, positionSeconds: 61.5 });
  assert.equal(adapter.published.length, 1);

  // A seek, a pause, and a new item each are discontinuities.
  controller.publish(owner(14, []), { ...libvlcPlaying, positionSeconds: 600 });
  controller.publish(owner(14, []), { ...libvlcPlaying, positionSeconds: 600, state: 'paused' });
  controller.publish(owner(14, []), { ...libvlcPlaying, sessionId: '/library/show/s01e02.mkv' });
  assert.equal(adapter.published.length, 4);
});

test('the controller keeps the latest position for the next relative seek', () => {
  const adapter = fakeAdapter();
  const calls: EngineCall[] = [];
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    engine: recordingEngine(calls),
  });

  controller.publish(owner(15, []), libvlcPlaying);
  // Not republished to the platform, but the controller still tracks it.
  controller.publish(owner(15, []), { ...libvlcPlaying, positionSeconds: 61 });
  adapter.send({ type: 'seekRelative', offsetSeconds: 30 });

  assert.equal(calls.at(-1)?.value, 91);
});

test('artwork reaches adapters as a local path, never as the renderer URL', () => {
  const adapter = fakeAdapter();
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    resolveArtworkPath: (snapshot) => (snapshot.artworkUrl ? '/tmp/loomtv/poster.img' : null),
  });

  controller.publish(owner(16, []), {
    ...libvlcPlaying,
    artworkUrl: 'http://127.0.0.1:8080/artwork/poster.jpg',
  });

  assert.equal(adapter.published.at(-1)?.artworkPath, '/tmp/loomtv/poster.img');
});

test('the device preference releases the session and refuses to claim', () => {
  const adapter = fakeAdapter();
  let enabled = true;
  const controller = createMediaSessionController({
    platform: 'darwin',
    candidates: () => [candidate(adapter)],
    isEnabled: () => enabled,
  });

  controller.publish(owner(17, []), libvlcPlaying);
  assert.equal(controller.ownerId(), 17);

  enabled = false;
  const diagnostics = controller.publish(owner(17, []), libvlcPlaying);
  assert.equal(controller.ownerId(), null);
  assert.equal(adapter.clears, 1);
  assert.equal(diagnostics.active, false);
  assert.match(String(diagnostics.reason), /turned off/);
});
