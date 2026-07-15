import { SUBTITLE_DELAY_LIMIT_SECONDS } from './constants.ts';

const BUFFERED_SEEK_TOLERANCE_SECONDS = 0.35;

export function resolveInitialPlaybackPosition(explicitPosition: number | undefined, savedPosition: number): number {
  const explicit = Number.isFinite(explicitPosition) ? Math.max(0, Number(explicitPosition)) : 0;
  const saved = Number.isFinite(savedPosition) ? Math.max(0, savedPosition) : 0;
  return explicit > 10 ? explicit : saved;
}

export function hasReachedInitialResumePosition(currentTime: number, resumePosition: number): boolean {
  const resume = Number.isFinite(resumePosition) ? Math.max(0, resumePosition) : 0;
  if (resume <= 10) return true;
  const current = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  return current >= resume - 1;
}

export function initialStreamOffset(resumePosition: number, requiresSeekRestart: boolean): number {
  if (!requiresSeekRestart || !Number.isFinite(resumePosition)) return 0;
  return Math.floor(Math.max(0, resumePosition));
}

export function initialHlsStartPosition({
  resumePosition,
  streamIsTranscoded,
  streamIsSeekable,
}: {
  resumePosition: number;
  streamIsTranscoded: boolean;
  streamIsSeekable: boolean;
}): number {
  const resume = Number.isFinite(resumePosition) ? Math.max(0, resumePosition) : 0;
  if (!streamIsTranscoded || streamIsSeekable) return resume;
  // A non-seekable transcode already starts its window at the requested
  // absolute position, so its HLS timeline must begin at zero.
  return 0;
}

export function playbackProgressForExit({
  videoPosition,
  snapshotPosition,
  transcodeStartSeconds,
  streamIsTranscoded,
  probedDuration,
  snapshotDuration,
  videoDuration,
}: {
  videoPosition: number;
  snapshotPosition: number;
  transcodeStartSeconds: number;
  streamIsTranscoded: boolean;
  probedDuration: number;
  snapshotDuration: number;
  videoDuration: number;
}): { position: number; duration: number } {
  const durationCandidates = [probedDuration, snapshotDuration, videoDuration]
    .filter((value) => Number.isFinite(value) && value > 0);
  const duration = durationCandidates[0] || 0;
  const safeVideoPosition = Number.isFinite(videoPosition) ? Math.max(0, videoPosition) : 0;
  const absoluteVideoPosition = streamIsTranscoded
    ? Math.max(0, transcodeStartSeconds) + safeVideoPosition
    : safeVideoPosition;
  const safeSnapshotPosition = Number.isFinite(snapshotPosition) ? Math.max(0, snapshotPosition) : 0;
  const position = absoluteVideoPosition > 0 ? absoluteVideoPosition : safeSnapshotPosition;

  return {
    position: duration > 0 ? Math.min(position, duration) : position,
    duration,
  };
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable || Boolean(target.closest('[contenteditable="true"], [role="textbox"]'));
}

export function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(
    'button, input, select, textarea, a, [role="slider"], [data-player-control], .player-side-panel',
  ));
}

export function clampSubtitleDelay(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(-SUBTITLE_DELAY_LIMIT_SECONDS, Math.min(SUBTITLE_DELAY_LIMIT_SECONDS, value));
  return Math.round(clamped * 100) / 100;
}

export function isTimeBuffered(
  buffered: TimeRanges | null | undefined,
  seconds: number,
  toleranceSeconds = BUFFERED_SEEK_TOLERANCE_SECONDS,
): boolean {
  if (!buffered || !Number.isFinite(seconds)) return false;
  const tolerance = Math.max(0, Number.isFinite(toleranceSeconds) ? toleranceSeconds : 0);
  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);
    if (seconds >= start - tolerance && seconds <= end + tolerance) return true;
  }
  return false;
}

export function transcodeSeekRestartOptions({ forceRestart }: { forceRestart: boolean }) {
  return {
    force: true,
    allowNearEnd: true,
    showSeekingStatus: true,
    keepReadyDuringRestart: !forceRestart,
    deferStopCurrent: !forceRestart,
  };
}

export function shouldShowSubtitleOverlay({
  subtitlesEnabled,
  selectedSubtitleTrackIndex,
  cueCount,
  subtitleIsBurnedIn,
}: {
  subtitlesEnabled: boolean;
  selectedSubtitleTrackIndex: number;
  cueCount: number;
  subtitleIsBurnedIn: boolean;
}): boolean {
  if (!subtitlesEnabled || selectedSubtitleTrackIndex === -1 || cueCount <= 0) return false;
  return !subtitleIsBurnedIn;
}

export function shouldRestartTranscodedSubtitleStyle({
  subtitleIsBurnedIn,
}: {
  subtitleIsBurnedIn: boolean;
}): boolean {
  return subtitleIsBurnedIn;
}

export type SubtitleTrackPlaybackAction = 'overlay' | 'burn-in' | 'reload-source';

export function subtitleTrackPlaybackAction({
  selectedTrackIndex,
  selectedSubtitleIsBitmap,
  activeSubtitleIsBurnedIn,
}: {
  selectedTrackIndex: number;
  selectedSubtitleIsBitmap: boolean;
  activeSubtitleIsBurnedIn: boolean;
}): SubtitleTrackPlaybackAction {
  if (selectedTrackIndex >= 0 && selectedSubtitleIsBitmap) return 'burn-in';
  return activeSubtitleIsBurnedIn ? 'reload-source' : 'overlay';
}

export function shouldUseNativeSubtitleTracks({
  subtitlesEnabled,
  selectedSubtitleTrackIndex,
  overlayVisible,
  subtitleIsBurnedIn,
}: {
  subtitlesEnabled: boolean;
  selectedSubtitleTrackIndex: number;
  overlayVisible: boolean;
  subtitleIsBurnedIn: boolean;
}): boolean {
  return subtitlesEnabled
    && selectedSubtitleTrackIndex <= -1000
    && !overlayVisible
    && !subtitleIsBurnedIn;
}
