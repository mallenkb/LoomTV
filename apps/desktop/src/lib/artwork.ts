import type { MediaItem } from '@/contexts/LibraryContext';

export type RouteArtworkState = {
  poster?: string;
  backdrop?: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
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
  const resolvedPosterSources = posterSources(item, routeArtwork, generated);

  return uniqueArtworkSources(
    routeArtwork?.backdropCandidates,
    routeArtwork?.backdrop,
    item.backdropCandidates,
    item.backdrop,
    resolvedPosterSources,
  );
}

export function logoSources(item: MediaItem, routeArtwork?: RouteArtworkState): string[] {
  return uniqueArtworkSources(
    routeArtwork?.logoCandidates,
    routeArtwork?.logo,
    item.logoCandidates,
    item.logo,
  );
}

export function routeArtworkState(item: MediaItem, visiblePosterSources: string[]): RouteArtworkState {
  return {
    poster: visiblePosterSources[0] || item.poster,
    backdrop: item.backdrop,
    logo: item.logo,
    posterCandidates: posterSources(item, { posterCandidates: visiblePosterSources }),
    backdropCandidates: uniqueArtworkSources(item.backdropCandidates, item.backdrop),
    logoCandidates: logoSources(item),
  };
}
