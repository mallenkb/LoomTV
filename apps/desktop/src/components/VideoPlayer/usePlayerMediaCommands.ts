import { useCallback, useRef, type RefObject } from 'react';
import type { MediaSessionCommand, MediaSessionCommandType } from '@/shared/mediaControlProtocol';
import type { PlaybackEngine } from './engines/PlaybackEngine';

type LiveControls = { step: (step: number) => void; last: () => void };

type PlayerMediaCommandOptions = {
  paused: boolean;
  userPausedRef: RefObject<boolean>;
  playbackEngineRef: RefObject<PlaybackEngine | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  isLiveStreamRef: RefObject<boolean>;
  liveControlsRef: RefObject<LiveControls>;
  playbackPositionRef: RefObject<number>;
  togglePlay: () => void;
  seekTo: (targetSeconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  setMediaSessionStopped: (stopped: boolean) => void;
  handleNextEpisode: () => void;
  handlePrevEpisode: () => void;
};

/**
 * Apply one system media command to the session that is already open.
 *
 * Every branch calls the player's own operations, so the active engine keeps
 * playing the file it already has: nothing here reopens the media, switches
 * engine, starts a transcode, or fetches metadata.
 *
 * `handledInMain` means the main process already ran the transport against
 * LibVLC or mpv, which is the normal path for a native engine. In that case
 * this only syncs the player's own pause intent so autoplay and the pause
 * overlay agree with what the engine is about to report. Repeats of a
 * transport command inside a quarter second are dropped, so a key that
 * reaches both the media session and the focused window acts once.
 */
export function usePlayerMediaCommands({
  paused,
  userPausedRef,
  playbackEngineRef,
  videoRef,
  isLiveStreamRef,
  liveControlsRef,
  playbackPositionRef,
  togglePlay,
  seekTo,
  setPlaybackRate,
  setMediaSessionStopped,
  handleNextEpisode,
  handlePrevEpisode,
}: PlayerMediaCommandOptions) {
  const lastMediaCommandRef = useRef<{ type: MediaSessionCommandType; at: number } | null>(null);

  return useCallback((
    command: MediaSessionCommand,
    handledInMain = false,
  ) => {
    if (command.type !== 'seekAbsolute') {
      const now = performance.now();
      const previous = lastMediaCommandRef.current;
      if (previous?.type === command.type && now - previous.at < 250) return;
      lastMediaCommandRef.current = { type: command.type, at: now };
    }

    if (handledInMain) {
      // The engine already moved. Record the user's intent so the player does
      // not treat the resulting state change as an unexpected pause.
      if (command.type === 'play') userPausedRef.current = false;
      else if (command.type === 'pause') userPausedRef.current = true;
      else if (command.type === 'toggle') userPausedRef.current = !paused;
      return;
    }

    switch (command.type) {
      case 'play':
        if (paused) togglePlay();
        break;
      case 'pause': {
        userPausedRef.current = true;
        const engine = playbackEngineRef.current;
        if (engine) {
          void engine.pause().catch((error) => console.warn('[player] Pause failed:', error));
        } else if (videoRef.current) {
          videoRef.current.autoplay = false;
          videoRef.current.pause();
        }
        break;
      }
      case 'toggle':
        togglePlay();
        break;
      case 'stop':
        // Stop ends playback and releases the session. It does not close the
        // player window: macOS sends stopCommand in more situations than users
        // expect, and tearing the UI down on it would be a bug.
        if (!paused) togglePlay();
        setMediaSessionStopped(true);
        break;
      case 'previousItem':
        if (isLiveStreamRef.current) liveControlsRef.current.step(-1);
        else handlePrevEpisode();
        break;
      case 'nextItem':
        if (isLiveStreamRef.current) liveControlsRef.current.step(1);
        else handleNextEpisode();
        break;
      case 'seekRelative':
        seekTo(playbackPositionRef.current + command.offsetSeconds);
        break;
      case 'seekAbsolute':
        seekTo(command.positionSeconds);
        break;
      case 'setRate':
        setPlaybackRate(Math.min(3, Math.max(0.25, command.rate)));
        break;
    }
  }, [
    handleNextEpisode,
    handlePrevEpisode,
    isLiveStreamRef,
    liveControlsRef,
    paused,
    playbackEngineRef,
    playbackPositionRef,
    seekTo,
    setMediaSessionStopped,
    setPlaybackRate,
    togglePlay,
    userPausedRef,
    videoRef,
  ]);
}
