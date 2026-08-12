import type { LanContentRating, LanOriginPlatform, LanProviderRatings, LanStreamingProvider } from '@loom-media-server/lan-protocol';
import type {
  WireEpisodeFile,
  WireEpisodeMeta,
  WireLocalMediaDetails,
  WireLocalMediaTrack,
  WireMediaItem,
  WireSubtitleRecord,
} from '../../shared/desktopProtocol.ts';

export type LocalMediaTrack = WireLocalMediaTrack;
export type LocalMediaDetails = WireLocalMediaDetails;
export type EpisodeMeta = WireEpisodeMeta;
export type EpisodeFile = WireEpisodeFile;
export type SubtitleRecord = WireSubtitleRecord;
export type ContentRatingSource = LanContentRating['source'];
export type ContentRating = LanContentRating;
export type ProviderRatings = LanProviderRatings;
export type StreamingOfferType = NonNullable<LanStreamingProvider['offerTypes']>[number];
export type StreamingProvider = LanStreamingProvider;
export type OriginPlatform = LanOriginPlatform;
export type MediaItem = WireMediaItem;

export interface TVMetadata extends Partial<MediaItem> {
  language?: string;
  country?: string;
  showType?: string;
}
