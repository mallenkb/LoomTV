const SUBTITLE_DELAY_LIMIT_SECONDS = 60;
const SCRUB_SEEK_COMMIT_INTERVAL_MS = 120;

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

export function shouldCommitScrubSeek({
  streamIsTranscoded,
  nowMs,
  lastCommitMs,
}: {
  streamIsTranscoded: boolean;
  nowMs: number;
  lastCommitMs: number;
}): boolean {
  return !streamIsTranscoded && nowMs - lastCommitMs >= SCRUB_SEEK_COMMIT_INTERVAL_MS;
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
