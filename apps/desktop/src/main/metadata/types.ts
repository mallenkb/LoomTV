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
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
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
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
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
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
}

export type SubtitleRecord = {
  lang: string;
  label: string;
  url: string;
  source?: 'sidecar' | 'opensubtitles';
  format?: string;
};

export type ContentRatingSource = 'tmdb' | 'omdb' | 'jikan';

export interface ContentRating {
  code: string;
  minimumAge: number;
  source: ContentRatingSource;
}

export type StreamingOfferType = 'subscription' | 'ads' | 'free' | 'rent' | 'buy';

export interface StreamingProvider {
  id: number;
  name: string;
  logoUrl: string;
  regions?: string[];
  offerTypes?: StreamingOfferType[];
  availability?: 'preferred-region' | 'other-region';
  source?: 'tmdb';
}

export interface OriginPlatform {
  id?: number;
  name: string;
  kind: 'network' | 'web-channel';
  countryCode?: string;
  countryName?: string;
  officialSite?: string;
  logoUrl?: string;
  source: 'tvmaze';
}

export interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  /** Canonical presentation format, e.g. Movie, TV, OVA, or ONA. */
  format?: string;
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
  streamingProviders?: StreamingProvider[];
  originPlatform?: OriginPlatform;
  genres: string[];
  cast: {
    name: string;
    character: string;
    image: string;
    characterName?: string;
    characterRole?: string;
    characterImage?: string;
    voiceActorName?: string;
    voiceActorImage?: string;
    voiceActorLanguage?: string;
  }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
  providerIds?: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    tvmazeId?: string;
    malId?: string;
    malIdBySeason?: Record<string, string>;
  };
}

export interface TVMetadata extends Partial<MediaItem> {
  language?: string;
  country?: string;
  showType?: string;
}
