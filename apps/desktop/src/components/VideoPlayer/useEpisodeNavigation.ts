import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { saveProgress as savePlaybackProgress } from '@/lib/progress';
import { NEXT_EPISODE_COUNTDOWN_SECONDS, WATCHED_THRESHOLD } from './constants';
import type { EpisodeFile } from './types';
import type { PlaybackEngine } from './engines/PlaybackEngine';

type UpdatePlaybackSnapshot = (
  position: number,
  duration?: number,
  options?: { forceReact?: boolean },
) => void;

type EpisodeNavigationOptions = {
  autoplayNextEnabled: boolean;
  currentEpisode: number;
  currentSeason: number;
  duration: number;
  episodeFiles: EpisodeFile[];
  filePath: string;
  nextEpisode: EpisodeFile | null;
  onEpisodeChange?: (filePath: string, season: number, episode: number) => void;
  playableEpisodes: EpisodeFile[];
  position: number;
  playbackDurationRef: RefObject<number>;
  playbackEngineRef: RefObject<PlaybackEngine | null>;
  probedDurationRef: RefObject<number>;
  pendingEpisodeTransitionRef: RefObject<string | null>;
  setPaused: Dispatch<SetStateAction<boolean>>;
  setProgressRevision: Dispatch<SetStateAction<number>>;
  suppressPauseIntentUntilMsRef: RefObject<number>;
  updatePlaybackSnapshot: UpdatePlaybackSnapshot;
  userPausedRef: RefObject<boolean>;
  videoRef: RefObject<HTMLVideoElement | null>;
};

export function useEpisodeNavigation({
  autoplayNextEnabled,
  currentEpisode,
  currentSeason,
  duration,
  episodeFiles,
  filePath,
  nextEpisode,
  onEpisodeChange,
  playableEpisodes,
  position,
  playbackDurationRef,
  playbackEngineRef,
  probedDurationRef,
  pendingEpisodeTransitionRef,
  setPaused,
  setProgressRevision,
  suppressPauseIntentUntilMsRef,
  updatePlaybackSnapshot,
  userPausedRef,
  videoRef,
}: EpisodeNavigationOptions) {
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
  }, []);

  const transitionToEpisode = useCallback((next: EpisodeFile) => {
    if (!onEpisodeChange || !next.filePath || next.filePath === filePath) return;

    pendingEpisodeTransitionRef.current = next.filePath;
    clearCountdown();
    userPausedRef.current = false;
    suppressPauseIntentUntilMsRef.current = performance.now() + 2000;
    const video = videoRef.current;
    if (playbackEngineRef.current) void playbackEngineRef.current.pause();
    if (video) {
      video.autoplay = false;
      video.pause();
    }
    setPaused(true);
    onEpisodeChange(next.filePath, next.season, next.episode);
  }, [
    clearCountdown,
    filePath,
    onEpisodeChange,
    pendingEpisodeTransitionRef,
    playbackEngineRef,
    setPaused,
    suppressPauseIntentUntilMsRef,
    userPausedRef,
    videoRef,
  ]);

  const goToEpisode = useCallback((season: number, episode: number) => {
    const next = episodeFiles.find((item) => item.season === season && item.episode === episode);
    if (next) transitionToEpisode(next);
  }, [episodeFiles, transitionToEpisode]);

  const goToPreviousEpisode = useCallback(() => {
    const currentIndex = playableEpisodes.findIndex((item) => (
      item.season === currentSeason && item.episode === currentEpisode
    ));
    const previous = currentIndex > 0 ? playableEpisodes[currentIndex - 1] : undefined;
    if (previous) goToEpisode(previous.season, previous.episode);
  }, [currentEpisode, currentSeason, goToEpisode, playableEpisodes]);

  const goToNextEpisode = useCallback(() => {
    if (nextEpisode) goToEpisode(nextEpisode.season, nextEpisode.episode);
  }, [goToEpisode, nextEpisode]);

  const markCurrentEpisodeComplete = useCallback(() => {
    const videoDuration = Number.isFinite(videoRef.current?.duration) ? Number(videoRef.current?.duration) : 0;
    const completeDuration = duration || playbackDurationRef.current || probedDurationRef.current || videoDuration;
    if (completeDuration <= 0) return;
    updatePlaybackSnapshot(completeDuration, completeDuration, { forceReact: true });
    void savePlaybackProgress(filePath, completeDuration, completeDuration);
    setProgressRevision((revision) => revision + 1);
  }, [
    duration,
    filePath,
    playbackDurationRef,
    probedDurationRef,
    setProgressRevision,
    updatePlaybackSnapshot,
    videoRef,
  ]);

  const playNextEpisodeNow = useCallback((forceComplete = false) => {
    if (!nextEpisode) return;
    if (forceComplete || (duration > 0 && position / duration >= WATCHED_THRESHOLD)) {
      markCurrentEpisodeComplete();
    }
    goToEpisode(nextEpisode.season, nextEpisode.episode);
  }, [duration, goToEpisode, markCurrentEpisodeComplete, nextEpisode, position]);

  const scheduleNextEpisode = useCallback(() => {
    if (!nextEpisode || !onEpisodeChange || nextEpisode.filePath === filePath || countdownTimerRef.current) return;
    clearCountdown();
    let remainingSeconds = NEXT_EPISODE_COUNTDOWN_SECONDS;
    setCountdown(remainingSeconds);
    countdownTimerRef.current = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        clearCountdown();
        goToEpisode(nextEpisode.season, nextEpisode.episode);
        return;
      }
      setCountdown(remainingSeconds);
    }, 1000);
  }, [clearCountdown, filePath, goToEpisode, nextEpisode, onEpisodeChange]);

  const latestPlaybackRef = useRef({
    autoplayNextEnabled,
    nextEpisodeFile: nextEpisode,
    markCurrentEpisodeComplete,
    scheduleNextEpisode,
  });

  useEffect(() => {
    latestPlaybackRef.current = {
      autoplayNextEnabled,
      nextEpisodeFile: nextEpisode,
      markCurrentEpisodeComplete,
      scheduleNextEpisode,
    };
  }, [autoplayNextEnabled, markCurrentEpisodeComplete, nextEpisode, scheduleNextEpisode]);

  useEffect(() => clearCountdown, [clearCountdown]);

  return {
    clearNextEpisodeCountdown: clearCountdown,
    goToEpisode,
    handleNextEpisode: goToNextEpisode,
    handlePrevEpisode: goToPreviousEpisode,
    latestEpisodePlaybackRef: latestPlaybackRef,
    markCurrentEpisodeComplete,
    nextCountdown: countdown,
    playNextEpisodeNow,
    scheduleNextEpisode,
  };
}
