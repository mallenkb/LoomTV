export type PlayerState = 'loading' | 'ready' | 'error';
export type ControlTab = 'video' | 'audio' | 'subtitles';
export type AspectMode = 'default' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4';
export type CropMode = 'none' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4' | 'custom';
export type RotationMode = 0 | 90 | 180 | 270;
export type TrackPreferenceType = 'audio' | 'subtitle';

export type SubtitleStyleSettings = {
  delaySeconds: number;
  position: number;
  scale: number;
  fontSize: number;
  fontColor: string;
  borderColor: string;
  borderWidth: number;
  borderEnabled: boolean;
  backgroundColor: string;
  backgroundEnabled: boolean;
};

export interface MediaTrack {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  profile?: string;
  pixelFormat?: string;
  default?: boolean;
  forced?: boolean;
  source?: 'embedded' | 'sidecar' | 'opensubtitles';
}

export type ProbeData = { durationSeconds?: number; tracks?: MediaTrack[] };

export type TrackPreference = {
  enabled: boolean;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
};

export type PlaybackTrackPreferences = {
  audio?: TrackPreference;
  subtitle?: TrackPreference;
};

export interface EpisodeMeta {
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  airDate: string;
}

export interface EpisodeFile {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  thumbnail?: string;
  still?: string;
  localMetadata?: {
    durationSeconds?: number;
  };
}

export interface VideoPlayerProps {
  mediaId?: string;
  filePath: string;
  title: string;
  artwork?: {
    logo?: string;
    logoCandidates?: string[];
    poster?: string;
    posterCandidates?: string[];
    backdrop?: string;
    backdropCandidates?: string[];
    rating?: number;
  };
  subtitles?: {
    lang: string;
    label: string;
    url: string;
    source?: 'sidecar' | 'opensubtitles';
    format?: string;
  }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
  startPosition?: number;
  onClose: () => void;
  onEpisodeChange?: (filePath: string, season: number, episode: number) => void;
}
