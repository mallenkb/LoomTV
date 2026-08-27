import type { MediaSessionEngineDispatcher } from './service.ts';
import type { MediaSessionEngine } from '../../shared/mediaControlProtocol.ts';
import type { PlaybackCommand } from '../../shared/playbackProtocol.ts';

/**
 * Run a transport command against the native engine already playing the file.
 *
 * LibVLC and mpv both live in the main process, so a media key reaches them
 * without a renderer round trip. That matters because `backgroundThrottling`
 * defaults to true, and Chromium throttles renderer timers whenever the window
 * is backgrounded, which is exactly the case system media controls exist for.
 *
 * Every command here is an operation on the running session. None of them
 * reopens the media, changes engine, starts a transcode, or reads metadata.
 */

export type NativeEngineCommands = {
  libvlc: (sessionId: string, command: PlaybackCommand) => boolean;
  mpv: (sessionId: string, command: PlaybackCommand) => boolean;
};

export function createEngineDispatcher(engines: NativeEngineCommands): MediaSessionEngineDispatcher {
  const send = (engine: MediaSessionEngine, sessionId: string, command: PlaybackCommand): boolean => {
    if (!sessionId) return false;
    if (engine === 'libvlc') return engines.libvlc(sessionId, command) === true;
    if (engine === 'mpv') return engines.mpv(sessionId, command) === true;
    // Chromium playback lives in the renderer, so the controller forwards it there.
    return false;
  };

  return {
    setPaused: (engine, sessionId, paused) => send(engine, sessionId, { type: 'set-paused', paused }),
    seek: (engine, sessionId, positionSeconds) => send(engine, sessionId, {
      type: 'seek',
      position: Math.max(0, positionSeconds),
    }),
    setRate: (engine, sessionId, rate) => send(engine, sessionId, { type: 'set-speed', speed: rate }),
  };
}
