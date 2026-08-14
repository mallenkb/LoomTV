import type { SubtitleStyleSettings } from './types';

export const SUBTITLES_DEFAULT_KEY = 'subtitlesDefaultEnabled';
export const SUBTITLE_STYLE_KEY = 'loomtvSubtitleStyle';
export const MAX_SUBTITLE_OUTLINE_WIDTH = 20;
export const WATCHED_THRESHOLD = 0.9;
export const CONTROLS_HIDE_MS = 3000;
export const NEXT_EPISODE_COUNTDOWN_SECONDS = 3;
export const NEXT_EPISODE_PROMPT_REMAINING_SECONDS = 30;
export const REPLAY_FROM_START_REMAINING_SECONDS = 8;
export const END_COMPLETION_TOLERANCE_SECONDS = 1.5;
export const HLS_RECOVERY_ATTEMPTS = 3;
export const HLS_TRANSCODE_RESTART_ATTEMPTS = 2;
// How many times a track-list snapshot may report an audio track other than the
// requested one before the player stops re-asking and shows what is playing.
export const MAX_AUDIO_REAPPLY_ATTEMPTS = 3;
export const DEFAULT_EPISODE_PANEL_WIDTH = 320;
export const DEFAULT_MEDIA_PANEL_WIDTH = 360;
export const MIN_SIDE_PANEL_WIDTH = 260;
export const MAX_SIDE_PANEL_RATIO = 0.4;
export const DEFAULT_SKIP_BACK_SECONDS = 10;
export const DEFAULT_SKIP_FORWARD_SECONDS = 15;
// When a transcoded seek lands outside the encoded region it must restart
// FFmpeg. Coalesce rapid seeks (skip-skip-skip / scrub) within this window so
// only the final target restarts once instead of restarting on every press.
export const TRANSCODE_SEEK_DEBOUNCE_MS = 260;
// Safety net: release the scrubber "hold" if a restart never reports playback.
export const TRANSCODE_SEEK_HOLD_TIMEOUT_MS = 8000;
export const SUBTITLE_DELAY_STEP_SECONDS = 0.5;
export const SUBTITLE_DELAY_FINE_STEP_SECONDS = 0.1;
export const SUBTITLE_DELAY_LIMIT_SECONDS = 60;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleSettings = {
  delaySeconds: 0,
  position: 96,
  scale: 1,
  fontSize: 32,
  fontColor: '#ffffff',
  borderColor: '#000000',
  borderWidth: 3,
  borderEnabled: true,
  backgroundColor: 'transparent',
  backgroundEnabled: false,
};
