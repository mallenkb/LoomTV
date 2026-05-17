export type PlayerState = 'loading' | 'ready' | 'error';
export type ControlTab = 'video' | 'audio' | 'subtitles';
export type AspectMode = 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9';
export type TrackPreferenceType = 'audio' | 'subtitle';

export type SubtitleStyleSettings = {
  delaySeconds: number;
  position: number;
  scale: number;
  fontSize: number;
  fontColor: string;
  borderColor: string;
  borderWidth: number;
  backgroundColor: string;
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
  subtitles?: { lang: string; label: string; url: string }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
  onClose: () => void;
  onEpisodeChange?: (filePath: string, season: number, episode: number) => void;
}
