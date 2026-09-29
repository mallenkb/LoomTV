import { useEffect, type RefObject } from 'react';
import { isTopmostModalContent } from '@/components/ui/dialog';
import type { MediaSessionCommand } from '@/shared/mediaControlProtocol';
import { firstSubtitleTrackIndex } from './helpers';
import { isEditableShortcutTarget, isPlayerControlTarget, isSliderShortcutTarget } from './playerControls';
import type { MediaTrack, PlayerState } from './types';

type LiveControls = { step: (step: number) => void; last: () => void };

type PlayerKeyboardShortcutOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  playerStateRef: RefObject<PlayerState>;
  playbackPositionRef: RefObject<number>;
  isLiveStreamRef: RefObject<boolean>;
  liveControlsRef: RefObject<LiveControls>;
  showLiveGuideRef: RefObject<boolean>;
  selectedSubtitleTrackIndexRef: RefObject<number>;
  probeTracksRef: RefObject<MediaTrack[]>;
  setShowLiveGuide: (open: boolean) => void;
  resetSurfaceDoubleClickGuard: () => void;
  toggleLiveGuide: () => void;
  changePlaybackRate: (delta: number) => void;
  changeVolume: (delta: number) => void;
  duration: number;
  fullscreen: boolean;
  handleBack: () => void;
  handleClose: () => void;
  handleNextEpisode: () => void;
  handlePrevEpisode: () => void;
  paused: boolean;
  resetPlaybackRate: () => void;
  runMediaSessionCommand: (command: MediaSessionCommand) => void;
  hasOnlineCaption: boolean;
  selectSubtitleTrack: (trackIndex: number, temporary?: boolean, onFailure?: () => void) => void;
  showSubtitlesPanel: () => void;
  skipBackSeconds: number;
  skipForwardSeconds: number;
  seekTo: (targetSeconds: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  togglePlay: () => void;
};

/**
 * Window-level player shortcuts. Handlers run in the capture phase so the
 * player owns its keys while it is the topmost modal, and Space is consumed on
 * both keydown and keyup so a focused button cannot also click.
 */
export function usePlayerKeyboardShortcuts({
  containerRef,
  playerStateRef,
  playbackPositionRef,
  isLiveStreamRef,
  liveControlsRef,
  showLiveGuideRef,
  selectedSubtitleTrackIndexRef,
  probeTracksRef,
  setShowLiveGuide,
  resetSurfaceDoubleClickGuard,
  toggleLiveGuide,
  changePlaybackRate,
  changeVolume,
  duration,
  fullscreen,
  handleBack,
  handleClose,
  handleNextEpisode,
  handlePrevEpisode,
  paused,
  resetPlaybackRate,
  runMediaSessionCommand,
  hasOnlineCaption,
  selectSubtitleTrack,
  showSubtitlesPanel,
  skipBackSeconds,
  skipForwardSeconds,
  seekTo,
  toggleMute,
  toggleFullscreen,
  togglePlay,
}: PlayerKeyboardShortcutOptions): void {
  useEffect(() => {
    const ownsShortcut = (event: KeyboardEvent) => (
      !event.defaultPrevented && !event.isComposing
      && isTopmostModalContent(containerRef.current)
      && !isEditableShortcutTarget(event.target) && !isPlayerControlTarget(event.target)
      && !isEditableShortcutTarget(document.activeElement) && !isPlayerControlTarget(document.activeElement)
    );
    const isPlaybackSpace = (event: KeyboardEvent) => (
      ownsShortcut(event)
      && (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar')
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
      && !isEditableShortcutTarget(event.target)
    );
    const onKey = (e: KeyboardEvent) => {
      // M also works when the volume button or slider has keyboard focus.
      if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey
        && !e.isComposing && !e.defaultPrevented && isTopmostModalContent(containerRef.current)
        && !isEditableShortcutTarget(e.target) && !isEditableShortcutTarget(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        resetSurfaceDoubleClickGuard();
        if (!e.repeat && playerStateRef.current !== 'error') toggleMute();
        return;
      }
      // Forward and back always seek while a video is playing, no matter which
      // panel or control holds focus. Typing targets, dropdowns, and native
      // sliders keep their own arrow behavior.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing
        && !isEditableShortcutTarget(e.target) && !isEditableShortcutTarget(document.activeElement)
        && !isSliderShortcutTarget(e.target) && !isSliderShortcutTarget(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (playerStateRef.current === 'error') return;
        resetSurfaceDoubleClickGuard();
        const step = e.shiftKey ? 30 : 10;
        seekTo(playbackPositionRef.current + (e.key === 'ArrowRight' ? step : -step));
        return;
      }
      if (e.key === 'Escape' || !ownsShortcut(e)) return;
      if (isPlaybackSpace(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat && playerStateRef.current !== 'error') togglePlay();
        return;
      }
      const hasCommandModifier = e.metaKey || e.ctrlKey || e.altKey;
      if (!hasCommandModifier && !e.isComposing
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && !isEditableShortcutTarget(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (playerStateRef.current === 'error') return;
        resetSurfaceDoubleClickGuard();
        changeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05);
        return;
      }
      if (isEditableShortcutTarget(e.target) || e.isComposing) return;
      if (playerStateRef.current === 'error') {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleClose();
        }
        return;
      }
      if (
        isPlayerControlTarget(e.target)
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)
      ) {
        return;
      }

      const key = e.code === 'Space' ? ' ' : e.key;
      if (isLiveStreamRef.current && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (key === 'PageUp' || key === 'PageDown') {
          e.preventDefault();
          liveControlsRef.current.step(key === 'PageUp' ? -1 : 1);
          return;
        }
        if (key === 'q' || key === 'Q') {
          e.preventDefault();
          liveControlsRef.current.last();
          return;
        }
        if (key === 'g' || key === 'G') {
          e.preventDefault();
          toggleLiveGuide();
          return;
        }
        if (key === 'Escape' && showLiveGuideRef.current) {
          e.preventDefault();
          setShowLiveGuide(false);
          return;
        }
      }
      switch (key) {
        case 'Escape':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          if (fullscreen) toggleFullscreen();
          else handleBack();
          break;
        case 'k':
        case 'K':
        case 'MediaPlayPause':
          if (hasCommandModifier) break;
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          runMediaSessionCommand({ type: 'toggle' });
          break;
        case 'j':
        case 'J':
        case 'MediaRewind':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          seekTo(playbackPositionRef.current - (e.shiftKey ? 60 : skipBackSeconds));
          break;
        case 'l':
        case 'L':
        case 'MediaFastForward':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          seekTo(playbackPositionRef.current + (e.shiftKey ? 60 : skipForwardSeconds));
          break;
        case 'MediaPlay':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          if (paused) togglePlay();
          break;
        case 'MediaPause':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          if (!paused) togglePlay();
          break;
        case 'MediaTrackPrevious':
        case 'MediaPreviousTrack':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          runMediaSessionCommand({ type: 'previousItem' });
          break;
        case 'MediaTrackNext':
        case 'MediaNextTrack':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          runMediaSessionCommand({ type: 'nextItem' });
          break;
        case 'Backspace':
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          handleBack();
          break;
        case 'f':
        case 'F':
          if (hasCommandModifier) break;
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'c':
        case 'C': {
          if (hasCommandModifier) break;
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          if (hasOnlineCaption || selectedSubtitleTrackIndexRef.current !== -1) break;
          const captionTrackIndex = firstSubtitleTrackIndex(probeTracksRef.current);
          if (captionTrackIndex === -1) {
            showSubtitlesPanel();
            break;
          }
          selectSubtitleTrack(captionTrackIndex, false, showSubtitlesPanel);
          break;
        }
        case '[':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          changePlaybackRate(-0.25);
          break;
        case ']':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          changePlaybackRate(0.25);
          break;
        case 'r':
        case 'R':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          resetPlaybackRate();
          break;
        case 'Home':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          seekTo(0);
          break;
        case 'End':
          resetSurfaceDoubleClickGuard();
          e.preventDefault();
          seekTo(duration);
          break;
        default:
          if (/^[0-9]$/.test(e.key) && duration > 0) {
            resetSurfaceDoubleClickGuard();
            e.preventDefault();
            seekTo((Number(e.key) / 10) * duration);
          }
          break;
      }
    };
    // Buttons can activate on Space keyup. Consume both halves of the gesture
    // so the previously focused control cannot also fire a synthetic click.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isPlaybackSpace(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [
    resetSurfaceDoubleClickGuard,
    toggleLiveGuide,
    changePlaybackRate,
    changeVolume,
    duration,
    fullscreen,
    handleBack,
    handleClose,
    handleNextEpisode,
    handlePrevEpisode,
    paused,
    resetPlaybackRate,
    runMediaSessionCommand,
    hasOnlineCaption,
    selectSubtitleTrack,
    showSubtitlesPanel,
    skipBackSeconds,
    skipForwardSeconds,
    seekTo,
    toggleMute,
    toggleFullscreen,
    togglePlay,
    // Refs and state setters are stable; listed for the hooks lint rule.
    containerRef,
    isLiveStreamRef,
    liveControlsRef,
    playbackPositionRef,
    playerStateRef,
    probeTracksRef,
    selectedSubtitleTrackIndexRef,
    setShowLiveGuide,
    showLiveGuideRef,
  ]);
}
