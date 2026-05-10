import type { MediaItem } from '@/contexts/LibraryContext';

export type RouteArtworkState = {
  poster?: string;
  backdrop?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
};

export function uniqueArtworkSources(...sources: Array<string | string[] | null | undefined>): string[] {
  return Array.from(new Set(sources.flat().filter((source): source is string => Boolean(source?.trim()))));
}

export function posterSources(item: MediaItem, routeArtwork?: RouteArtworkState, generated: string[] = []): string[] {
  return uniqueArtworkSources(
    routeArtwork?.posterCandidates,
    routeArtwork?.poster,
    item.posterCandidates,
    item.poster,
    generated,
  );
}

export function backdropSources(item: MediaItem, routeArtwork?: RouteArtworkState, generated: string[] = []): string[] {
  return uniqueArtworkSources(
    routeArtwork?.backdropCandidates,
    routeArtwork?.backdrop,
    item.backdropCandidates,
    item.backdrop,
    routeArtwork?.posterCandidates,
    routeArtwork?.poster,
    item.posterCandidates,
    item.poster,
    generated,
  );
}

export function routeArtworkState(item: MediaItem, visiblePosterSources: string[]): RouteArtworkState {
  return {
    poster: visiblePosterSources[0] || item.poster,
    backdrop: item.backdrop,
    posterCandidates: posterSources(item, { posterCandidates: visiblePosterSources }),
    backdropCandidates: backdropSources(item),
  };
}
