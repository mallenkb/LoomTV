import type { SubtitleStyleSettings } from './types';

export const SUBTITLES_DEFAULT_KEY = 'subtitlesDefaultEnabled';
export const SUBTITLE_STYLE_KEY = 'loomtvSubtitleStyle';
export const AUTOPLAY_NEXT_EPISODE_KEY = 'loomtvAutoplayNextEpisode';
export const TRACK_PREFERENCES_KEY = 'loomtvPlaybackTrackPreferences';
export const MAX_SUBTITLE_OUTLINE_WIDTH = 20;
export const WATCHED_THRESHOLD = 0.9;
export const CONTROLS_HIDE_MS = 3000;
export const NEXT_EPISODE_COUNTDOWN_SECONDS = 3;
export const NEXT_EPISODE_PROMPT_REMAINING_SECONDS = 30;
export const REPLAY_FROM_START_REMAINING_SECONDS = 8;
export const END_COMPLETION_TOLERANCE_SECONDS = 1.5;
export const HLS_RECOVERY_ATTEMPTS = 3;
export const HLS_TRANSCODE_RESTART_ATTEMPTS = 2;
export const HLS_FIRST_EXTENSIONS = new Set(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts']);
export const DEFAULT_EPISODE_PANEL_WIDTH = 288;
export const DEFAULT_MEDIA_PANEL_WIDTH = 360;
export const MIN_SIDE_PANEL_WIDTH = 260;
export const MAX_SIDE_PANEL_RATIO = 0.4;
export const DEFAULT_SKIP_BACK_SECONDS = 10;
export const DEFAULT_SKIP_FORWARD_SECONDS = 15;
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
