import { Fragment } from 'react';
import { Star } from 'lucide-react';
import type { MediaItem } from '@/contexts/LibraryContext';
import ContentRatingBadge, { preferredContentRating } from '@/components/ContentRatingBadge';
import ProviderMark from '@/components/ProviderMark';
import ProviderRatingLogo from '@/components/ProviderRatingLogo';
import MediaTechnicalBadges, { mediaTechnicalMetadata } from '@/components/MediaTechnicalBadges';
import { mediaFormatLabel } from '@/shared/mediaFormat';

type HeroMetadataProps = {
  item: Pick<MediaItem, 'id' | 'type' | 'format' | 'genres' | 'rating' | 'providerRatings' | 'year' | 'contentRatings' | 'contentRating' | 'streamingProviders' | 'originPlatform' | 'runtime' | 'seasonCount' | 'episodeCount' | 'localMetadata' | 'seasons' | 'episodes' | 'episodeFiles'>;
};

function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return '';
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatRuntime(runtime?: string): string {
  const normalized = runtime?.trim().replace(/\s+/g, ' ') || '';
  if (!normalized) return '';
  const minuteMatch = normalized.match(/^(\d+)\s*(?:m|min|mins|minutes?)$/i);
  if (!minuteMatch) return normalized;
  return formatDuration(Number(minuteMatch[1]) * 60);
}

function episodeCountFromRuntime(runtime?: string): number {
  const match = runtime?.trim().match(/^(\d+)\s*eps?$/i);
  return match ? Number(match[1]) : 0;
}

export default function HeroMetadata({ item }: HeroMetadataProps) {
  const contentRating = preferredContentRating(item.contentRatings, item.contentRating);
  const mediaType = item.type === 'anime' ? 'Anime' : item.type === 'tv' ? 'TV Show' : 'Movie';
  const mediaFormat = mediaFormatLabel(item.format, item.type);
  const regularSeasonNumbers = new Set([
    ...(item.seasons || []).filter((season) => season.number > 0).map((season) => season.number),
    ...(item.episodeFiles || []).filter((episode) => episode.season > 0).map((episode) => episode.season),
  ]);
  const reportedSeasonCount = item.seasonCount || regularSeasonNumbers.size;
  const regularEpisodeCount = item.episodes?.filter((episode) => episode.season > 0).length
    || item.episodeFiles?.filter((episode) => episode.season > 0).length
    || item.seasons?.filter((season) => season.number > 0)
      .reduce((total, season) => total + Math.max(0, season.episodeCount || 0), 0)
    || 0;
  const allEpisodeCount = item.episodes?.length
    || item.episodeFiles?.length
    || item.seasons?.reduce((total, season) => total + Math.max(0, season.episodeCount || 0), 0)
    || 0;
  const episodeCount = item.episodeCount
    || regularEpisodeCount
    || allEpisodeCount
    || episodeCountFromRuntime(item.runtime);
  const seasonCount = reportedSeasonCount;
  const hasSeriesMetadata = item.type !== 'movie' && (seasonCount > 0 || episodeCount > 0);
  const durationLabel = (item.type === 'movie' || (item.type === 'anime' && !hasSeriesMetadata))
    ? formatDuration(item.localMetadata?.durationSeconds) || formatRuntime(item.runtime)
    : '';
  const seriesMetadata = item.type !== 'movie' && hasSeriesMetadata
    ? [
        seasonCount > 0 ? `${seasonCount} Season${seasonCount === 1 ? '' : 's'}` : '',
        episodeCount > 0 ? `${episodeCount} Episode${episodeCount === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
    : [];
  const secondaryMetadata = [
    item.year > 0 ? String(item.year) : '',
    durationLabel,
    ...seriesMetadata,
  ].filter(Boolean);
  const providerRatings = [
    item.providerRatings?.imdb
      ? {
          label: 'IMDb',
          value: item.providerRatings.imdb.value.toFixed(1),
          title: item.providerRatings.imdb.votes === undefined
            ? 'IMDb rating supplied by OMDb'
            : `IMDb rating from ${item.providerRatings.imdb.votes.toLocaleString()} votes, supplied by OMDb`,
          provider: 'imdb' as const,
          logoClassName: 'h-5 w-10 object-contain',
        }
      : null,
    item.providerRatings?.rottenTomatoes
      ? {
          label: 'Tomatometer',
          value: `${item.providerRatings.rottenTomatoes.value.toFixed(0)}%`,
          title: 'Rotten Tomatoes Tomatometer score supplied by OMDb',
          provider: 'tomatometer' as const,
          logoClassName: 'h-5 w-5 object-contain',
        }
      : null,
    item.providerRatings?.popcornmeter
      ? {
          label: 'Popcornmeter',
          value: `${item.providerRatings.popcornmeter.value.toFixed(0)}%`,
          title: 'Rotten Tomatoes Popcornmeter score',
          provider: 'popcornmeter' as const,
          logoClassName: 'h-5 w-5 object-contain',
        }
      : null,
    item.providerRatings?.metacritic
      ? {
          label: 'Metacritic',
          value: item.providerRatings.metacritic.value.toFixed(0),
          title: 'Metacritic score supplied by OMDb',
          provider: 'metacritic' as const,
          logoClassName: 'h-5 w-5 object-contain',
        }
      : null,
  ].filter((rating): rating is NonNullable<typeof rating> => rating !== null);
  const hasRating = providerRatings.length > 0 || item.rating > 0;
  const technicalMetadata = mediaTechnicalMetadata(item);
  const hasTechnicalMetadata = Boolean(
    technicalMetadata.resolution || technicalMetadata.audio || technicalMetadata.hasSubtitles,
  );

  return (
    <div className="loom-modern-hero-text mt-3 flex w-full max-w-[46rem] flex-col items-start text-[var(--loom-on-media)]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[clamp(1rem,1.35vw,1.45rem)] font-semibold">
        <span className="inline-flex items-center gap-2">
          <ProviderMark
            mediaId={item.id}
            providers={item.streamingProviders}
            originPlatform={item.originPlatform}
          />
          <span>{[mediaType, ...item.genres.slice(0, 2)].join(' · ')}</span>
        </span>
        <ContentRatingBadge
          rating={mediaFormat}
          className="border-[var(--loom-accent)]/75 bg-white/10 text-[var(--loom-accent)]"
        />
        {contentRating && <ContentRatingBadge rating={contentRating} className="border-white/75 bg-white/10 text-white" />}
      </div>

      {(hasRating || secondaryMetadata.length > 0 || hasTechnicalMetadata) && (
        <div className="loom-modern-hero-text mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[clamp(0.95rem,1.2vw,1.2rem)] font-semibold text-[var(--loom-on-media-muted)]">
          {providerRatings.map((rating, index) => (
            <Fragment key={rating.label}>
              {index > 0 && <span aria-hidden="true">•</span>}
              <span
                className="loom-rating inline-flex items-center gap-1.5 text-sm text-white"
                title={rating.title}
                aria-label={`${rating.label} ${rating.value}`}
              >
                <ProviderRatingLogo provider={rating.provider} className={rating.logoClassName} />
                <span aria-hidden="true">{rating.value}</span>
              </span>
            </Fragment>
          ))}
          {providerRatings.length === 0 && item.rating > 0 && (
            <span className="loom-rating inline-flex items-center gap-1.5">
              <Star className="h-4 w-4" fill="currentColor" />
              {item.rating.toFixed(1)}
            </span>
          )}
          {hasRating && secondaryMetadata.length > 0 && <span aria-hidden="true">•</span>}
          {secondaryMetadata.map((value, index) => (
            <Fragment key={`${value}-${index}`}>
              {index > 0 && <span aria-hidden="true">•</span>}
              <span>{value}</span>
            </Fragment>
          ))}
          <MediaTechnicalBadges item={item} />
        </div>
      )}
    </div>
  );
}
