export interface LocalMediaTrack {
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

export interface LocalMediaDetails {
  fileSize?: number;
  modifiedAtMs?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  tracks?: LocalMediaTrack[];
  bitrateKbps?: number;
  container?: string;
  chapters?: { startMs: number; endMs: number; title: string }[];
}

export interface EpisodeMeta {
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  airDate: string;
  localMetadata?: LocalMediaDetails;
}

export interface EpisodeFile {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  thumbnail?: string;
  still?: string;
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
}

export interface ContentRating {
  code: string;
  minimumAge: number;
  source: string;
}

export interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year: number;
  poster: string;
  backdrop: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  summary: string;
  rating: number;
  contentRatings?: Record<string, ContentRating>;
  genres: string[];
  cast: { name: string; character: string; image: string }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
  providerIds?: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    malId?: string;
    malIdBySeason?: Record<string, string>;
  };
}

export interface TVMetadata extends Partial<MediaItem> {
  language?: string;
  country?: string;
  showType?: string;
}
