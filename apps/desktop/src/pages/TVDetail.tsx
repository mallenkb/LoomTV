import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Check, Play, Star, UserRound, ChevronRight, ChevronDown } from 'lucide-react';
import { libraryMutationMessage, useLibrary, TVShow, EpisodeMeta, EpisodeFile } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { desktopApi } from '@/lib/desktopApi';
import SafeArtwork from '@/components/SafeArtwork';
import { WatchedSolidIcon } from '@/components/LoomIcons';
import { backdropSources, logoSources, posterSources, RouteArtworkState, uniqueArtworkSources } from '@/lib/artwork';
import { getProgressState, resetProgress, useProgressRefreshRevision } from '@/lib/progress';
import { loadCustomArtwork } from '@/lib/customArtwork';
import ArtworkEditorControls, { CustomArtworkState } from '@/components/ArtworkEditorControls';
import { cleanEpisodeTitleForDisplay, episodeCode } from '@/lib/episodeTitles';
import { useTheme } from '@/components/ThemeProvider';
import SharedListHighlight from '@/components/SharedListHighlight';
import { getCachedDiscoverReturnRoute, getCachedExploreItem } from '@/lib/discoverNavigation';
import type { StremioPluginCatalogItem } from '@/shared/desktopProtocol';
import TrailerDialog from '@/components/TrailerDialog';
import HeroMetadata from '@/components/HeroMetadata';
import { normalizeAnimeCast } from '@/shared/animeCast';
import DetailHeroActions from '@/components/DetailHeroActions';
import { cacheWatchedDiscoverItem, discoverWatchedKey, localProgressPathsForItem, localWatchedKeysForItem } from '@/lib/watched';
import { aniListCastResponseSchema, type AniListCharacterEdge } from '@/lib/anilistSchemas';

interface TVDetailProps {
  kind?: 'series' | 'anime';
  onPlay?: (
    filePath: string,
    title: string,
    subtitles?: TVShow['subtitles'],
    episodes?: EpisodeMeta[],
    episodeFiles?: EpisodeFile[],
    currentSeason?: number,
    currentEpisode?: number,
    mediaId?: string,
    artwork?: Pick<RouteArtworkState, 'logo' | 'logoCandidates' | 'poster' | 'posterCandidates' | 'backdrop' | 'backdropCandidates'>,
  ) => void;
}

function epCode(season: number, episode: number): string {
  return episodeCode(season, episode);
}

function episodeTitleDisplay(title: string | undefined, seriesTitle: string, season: number, episode: number): string {
  return cleanEpisodeTitleForDisplay(title, seriesTitle, season, episode);
}

function formatShortMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

const episodeAirDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
});

function formatEpisodeAirDate(value?: string): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return '';

  return episodeAirDateFormatter.format(date);
}

function formatThumbnailTime(seconds: number, duration = 0): string {
  const upperBound = duration > 30 ? duration - 10 : seconds;
  const safeSeconds = Math.max(10, Math.min(Math.floor(seconds || 180), Math.floor(upperBound || seconds || 180)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

const CUSTOM_ARTWORK_KEY = 'loomtvCustomShowArtwork';
type DetailTab = 'episodes' | 'details';

type TVDetailRouteState = {
  from?: string;
  fromDiscover?: boolean;
  addonId?: string;
  stremioCatalogItem?: StremioPluginCatalogItem;
  artwork?: RouteArtworkState;
};

function normalizeRouteYear(releaseInfo?: string, released?: string): number {
  const match = `${releaseInfo || ''} ${released || ''}`.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

function seasonDisplayTitle(number: number, title: string): string {
  if (number === 0) return 'Specials';

  const label = `Season ${number}`;
  const normalizedTitle = title.trim();
  if (!normalizedTitle || new RegExp(`^Season\\s+0*${number}$`, 'i').test(normalizedTitle)) return label;

  const name = normalizedTitle.replace(
    new RegExp(`^Season\\s+0*${number}(?:\\s*[:\\-]\\s*|\\s+)`, 'i'),
    '',
  ).trim();
  return name ? `${label}: ${name}` : label;
}

function isCatalogTypeForKind(kind: 'series' | 'anime', type: string): boolean {
  return kind === 'anime' ? type === 'anime' : type === 'series' || type === 'tv';
}

function showFromStremioCatalogItem(
  kind: 'series' | 'anime',
  item: StremioPluginCatalogItem | null | undefined,
): TVShow | null {
  if (!item || !isCatalogTypeForKind(kind, item.type)) return null;
  const poster = item.artwork?.poster || item.posterUrl || '';
  const backdrop = item.artwork?.background || item.backgroundUrl || poster;
  return {
    id: item.id,
    type: item.type === 'anime' ? 'anime' : 'tv',
    format: item.format,
    title: item.title,
    year: normalizeRouteYear(item.releaseInfo, item.released),
    poster,
    backdrop,
    logo: item.artwork?.logo || item.logoUrl || '',
    summary: item.description || '',
    rating: item.rating || 0,
    providerRatings: item.providerRatings,
    contentRating: item.contentRating,
    streamingProviders: item.streamingProviders,
    trailerUrl: item.trailerUrl,
    runtime: item.runtime,
    seasonCount: item.seasonCount,
    episodeCount: item.episodeCount,
    genres: [...item.genres],
    cast: (kind === 'anime' ? normalizeAnimeCast(item.cast || []) : item.cast || []).map((person) => ({
      name: person.name,
      character: person.character || '',
      image: person.image || '',
      characterName: person.characterName,
      characterRole: person.characterRole,
      characterImage: person.characterImage,
      voiceActorName: person.voiceActorName,
      voiceActorImage: person.voiceActorImage,
      voiceActorLanguage: person.voiceActorLanguage,
    })),
    filePath: '',
    seasons: [],
    subtitles: [],
    episodes: [],
    episodeFiles: [],
    posterCandidates: poster ? [poster] : [],
    backdropCandidates: backdrop ? [backdrop] : [],
    logoCandidates: item.artwork?.logo || item.logoUrl ? [item.artwork?.logo || item.logoUrl || ''] : [],
  };
}

function creditInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase() || '—';
}

function formatCreditRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Character';
}

function animeCastNeedsRefresh(cast: TVShow['cast']): boolean {
  const normalized = normalizeAnimeCast(cast);
  return normalized.length === 0 || normalized.some((credit) => {
    const role = (credit.characterRole || '').trim().toLowerCase();
    return !credit.characterImage || !['main', 'supporting', 'background'].includes(role);
  });
}

const ANILIST_CAST_QUERY = `
  query ($id: Int!) {
    Media(id: $id, type: ANIME) {
      characters(page: 1, perPage: 20, sort: [ROLE, FAVOURITES_DESC]) {
        edges {
          node {
            name { full }
            image { large medium }
          }
          role
          voiceActors {
            name { full }
            image { large medium }
            languageV2
          }
        }
      }
    }
  }
`;

function aniListImageUrl(image?: { large?: string | null; medium?: string | null } | null): string {
  return image?.large || image?.medium || '';
}

function aniListVoiceActorPriority(language?: string | null): number {
  return language?.trim().toLowerCase() === 'japanese' ? 0 : 1;
}

function mapAniListCast(edges: AniListCharacterEdge[]): TVShow['cast'] {
  return edges
    .filter((edge) => (
      (edge.role === 'MAIN' || edge.role === 'SUPPORTING')
      && Boolean(edge.node?.name?.full)
    ))
    .map((edge) => {
      const characterName = edge.node?.name?.full || 'Unknown character';
      const characterImage = aniListImageUrl(edge.node?.image);
      const voiceActor = [...(edge.voiceActors || [])]
        .filter((actor) => Boolean(actor.name?.full))
        .sort((left, right) => (
          aniListVoiceActorPriority(left.languageV2) - aniListVoiceActorPriority(right.languageV2)
        ))[0];
      const voiceActorName = voiceActor?.name?.full || '';

      return {
        name: characterName,
        character: edge.role || '',
        image: characterImage,
        characterName,
        characterRole: edge.role || '',
        characterImage,
        voiceActorName,
        voiceActorImage: aniListImageUrl(voiceActor?.image),
        voiceActorLanguage: voiceActor?.languageV2 || '',
      };
    });
}

async function fetchAniListCastById(mediaId: string): Promise<TVShow['cast']> {
  const id = Number(mediaId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];

  const payload = aniListCastResponseSchema.parse(await desktopApi.requestMetadataProvider({
    provider: 'anilist',
    query: ANILIST_CAST_QUERY,
    variables: { id },
  }));
  if (payload.errors?.length) throw new Error(payload.errors[0]?.message || 'AniList cast request returned an error.');
  return mapAniListCast(payload.data?.Media?.characters?.edges || []);
}

function AnimeCreditRows({ credits }: { credits: TVShow['cast'] }) {
  const normalizedCredits = normalizeAnimeCast(credits);

  return (
    <div role="list" aria-label="Anime character and voice actor credits" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {normalizedCredits.map((credit, index) => {
        const characterName = credit.characterName || credit.name || 'Unknown character';
        const characterRole = formatCreditRole(credit.characterRole || credit.character || 'Character');
        const characterImage = credit.characterImage || credit.image || '';
        const actorName = credit.voiceActorName || '';
        const actorImage = credit.voiceActorImage || '';
        const accessibleLabel = actorName
          ? `${characterName} — voiced by ${actorName}`
          : `${characterName} — no voice actor listed`;

        return (
          <div
            key={`${characterName}:${actorName}:${index}`}
            role="listitem"
            aria-label={accessibleLabel}
            className="overflow-hidden rounded-[12px] border border-white/5 bg-[var(--loom-season-accordion-bg)]"
          >
            <div className="px-[16px] py-[12px]">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar className="h-14 w-14 shrink-0 rounded-full">
                  {characterImage ? (
                    <AvatarImage src={characterImage} alt={`${characterName} character portrait`} className="object-cover" />
                  ) : (
                    <AvatarFallback className="rounded-full bg-[var(--loom-season-accordion-bg)] text-sm text-[var(--loom-text)]">{creditInitials(characterName)}</AvatarFallback>
                  )}
                </Avatar>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-[16px] font-semibold leading-5 text-[var(--loom-text)]">{characterName}</p>
                  <p className="truncate text-xs tracking-wide text-[var(--loom-muted)]">{characterRole}</p>
                </div>
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-3 bg-[var(--loom-season-episodes-veil)] px-[16px] py-[12px]">
              <Avatar className="h-14 w-14 shrink-0 rounded-full">
                {actorImage ? (
                  <AvatarImage src={actorImage} alt={`${actorName || 'Voice actor'} portrait`} className="object-cover" />
                ) : (
                  <AvatarFallback className="rounded-full bg-[var(--loom-season-episodes-veil)] text-[var(--loom-muted)]">
                    <UserRound aria-hidden="true" className="h-6 w-6" />
                  </AvatarFallback>
                )}
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-[16px] font-medium leading-5 text-[var(--loom-text)]">{actorName || 'Voice actor not listed'}</p>
                <p className="text-xs font-semibold text-[var(--loom-muted)]">Voice actor</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function findLocalShowMatch(shows: readonly TVShow[], mediaId: string | undefined): TVShow | null {
  return mediaId ? shows.find((item) => item.id === mediaId) || null : null;
}

export default function TVDetail({ kind = 'series', onPlay }: TVDetailProps) {
  const { id: mediaId } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refreshLibrary, hydrateLibraryItem } = useLibrary();
  const { canManageProfiles, lists, setListEntry, watchedKeys, setWatchedEntries } = useProfiles();
  const { theme } = useTheme();
  const [show, setShow] = useState<TVShow | null>(null);
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const accordionPageKeyRef = useRef('');
  const accordionWasToggledRef = useRef(false);
  const progressTick = useProgressRefreshRevision();
  const [fallbackThumbnails, setFallbackThumbnails] = useState<string[]>([]);
  const [customArtwork, setCustomArtwork] = useState<CustomArtworkState>({});
  const [libraryActionError, setLibraryActionError] = useState('');
  const [detailsReady, setDetailsReady] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [metadataRefreshState, setMetadataRefreshState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const routeState = (location.state as TVDetailRouteState | null) || null;
  // Explore/remote records use a provider-owned ID and artwork contract.
  // Keep that cache out of ordinary local routes so a colliding provider ID
  // cannot replace the library's TMDB/OMDb/Jikan-hydrated record.
  const isRemoteDetailRoute = Boolean(
    routeState?.stremioCatalogItem
    || routeState?.fromDiscover
    || routeState?.from?.startsWith('/discover'),
  );
  const routeCatalogItem = useMemo(
    () => routeState?.stremioCatalogItem || (isRemoteDetailRoute
      ? getCachedExploreItem(kind === 'anime' ? 'anime' : 'tv', mediaId)
      : null),
    [isRemoteDetailRoute, kind, mediaId, routeState?.stremioCatalogItem],
  );
  const routeFallbackShow = useMemo(
    () => showFromStremioCatalogItem(
      kind,
      routeCatalogItem || undefined,
    ),
    [kind, routeCatalogItem],
  );
  const routeAddonId = routeState?.addonId;
  const [isRemoteStremioShow, setIsRemoteStremioShow] = useState(Boolean(routeState?.stremioCatalogItem));
  const routeAddonType = kind === 'anime'
    ? 'anime'
    : routeState?.stremioCatalogItem?.type === 'tv' ? 'tv' : 'series';
  const shouldOpenDetailsFirst = Boolean(routeState?.fromDiscover || routeState?.from?.startsWith('/discover') || isRemoteStremioShow);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>(shouldOpenDetailsFirst ? 'details' : 'episodes');
  const metadataFetchKeyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    const pageKey = `${kind}:${mediaId || ''}`;
    if (accordionPageKeyRef.current !== pageKey) {
      accordionPageKeyRef.current = pageKey;
      accordionWasToggledRef.current = false;
    }

    const collection = kind === 'anime' ? state.animeShows : state.tvShows;
    // Remote metadata cannot authorize playback of a same-title local show.
    // Only an explicit future host binding may connect provider identity to a
    // local library identity.
    const found = routeFallbackShow ? null : findLocalShowMatch(collection, mediaId);
    const nextShow = routeFallbackShow || found;
    if (routeFallbackShow) setIsRemoteStremioShow(true);
    else if (found) setIsRemoteStremioShow(false);
    setShow(nextShow);
    const fetchKey = mediaId ? `${routeAddonId || 'opaque'}|${routeAddonType}|${mediaId}` : '';
    if (!nextShow && mediaId && metadataFetchKeyRef.current !== fetchKey) {
      metadataFetchKeyRef.current = fetchKey;
      const metadataRequest = routeAddonId
        ? desktopApi.getStremioMeta(routeAddonId, { type: routeAddonType, id: mediaId })
        : desktopApi.getStremioMetaByItem({ type: routeAddonType, id: mediaId });
      void metadataRequest
        .then((result) => {
          if (cancelled) return;
          const remoteShow = showFromStremioCatalogItem(kind, result.item);
          if (remoteShow) {
            setShow(remoteShow);
            setIsRemoteStremioShow(true);
          }
        })
        .catch((error) => {
          if (!cancelled) console.warn('Could not load Discover series metadata:', error);
          metadataFetchKeyRef.current = '';
        });
    } else if (!fetchKey) {
      metadataFetchKeyRef.current = '';
    }
    if (found?.catalogRevision !== undefined) {
      void hydrateLibraryItem(found.id)
        .then((details) => {
          if (cancelled || !details) return;
          setShow(details as TVShow);
        })
        .catch((error) => console.warn('Could not hydrate series details:', error));
    }
    if (nextShow && !accordionWasToggledRef.current) {
      const firstVisibleSeason = (nextShow.seasons || []).find((season) =>
        (nextShow.episodeFiles?.some((ef) => ef.season === season.number) || false)
        || (nextShow.episodes?.some((ep) => ep.season === season.number) || false),
      );
      const resumeEpisode = nextShow.episodeFiles?.find((file) =>
        getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress,
      );
      const nextEpisode = nextShow.episodeFiles?.find((file) =>
        !getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched,
      );
      setExpandedSeason(resumeEpisode?.season ?? nextEpisode?.season ?? firstVisibleSeason?.number ?? null);
    }
    return () => { cancelled = true; };
  }, [hydrateLibraryItem, kind, mediaId, progressTick, routeAddonId, routeAddonType, routeFallbackShow, shouldOpenDetailsFirst, state.animeShows, state.catalogRevision, state.tvShows]);

  const toggleSeason = (seasonNumber: number) => {
    accordionWasToggledRef.current = true;
    setExpandedSeason((current) => current === seasonNumber ? null : seasonNumber);
  };

  useEffect(() => {
    setDetailsReady(false);
    setActiveDetailTab(shouldOpenDetailsFirst ? 'details' : 'episodes');
    const frame = window.requestAnimationFrame(() => setDetailsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [show?.id, shouldOpenDetailsFirst]);

  useEffect(() => {
    if (kind !== 'anime' || !isRemoteStremioShow || !show?.id) return;
    if (!animeCastNeedsRefresh(show.cast)) return;

    if (Number.isSafeInteger(Number(show.id)) && Number(show.id) > 0) {
      let cancelled = false;
      void fetchAniListCastById(show.id)
        .then((cast) => {
          if (cancelled || cast.length === 0) return;
          setShow((current) => current?.id === show.id ? { ...current, cast } : current);
        })
        .catch((error) => console.warn('Could not load AniList cast:', error));
      return () => { cancelled = true; };
    }
  }, [isRemoteStremioShow, kind, show?.cast, show?.id]);

  const handleRefreshIncompleteMetadata = async () => {
    if (!show?.id || isRemoteStremioShow || metadataRefreshState === 'loading') return;
    setMetadataRefreshState('loading');
    try {
      await desktopApi.refreshIncompleteMetadata(show.id);
      const refreshed = await hydrateLibraryItem(show.id);
      if (refreshed) setShow(refreshed as TVShow);
      else await refreshLibrary();
      setMetadataRefreshState('success');
      window.setTimeout(() => setMetadataRefreshState('idle'), 2200);
    } catch (error) {
      console.warn('Could not refresh incomplete metadata:', error);
      setMetadataRefreshState('error');
      window.setTimeout(() => setMetadataRefreshState('idle'), 2600);
    }
  };

  // Custom artwork is keyed by media id, so it reloads only when the title
  // changes. Reloading it whenever an artwork field changes would blank the
  // crop the user just applied: saving triggers refreshLibrary(), which
  // rewrites exactly those fields, and the page would fall back to stale art
  // until it was reopened.
  useEffect(() => {
    if (!show?.id) return;
    setCustomArtwork({});
    void loadCustomArtwork(show.id, CUSTOM_ARTWORK_KEY)
      .then((artwork) => setCustomArtwork(artwork as CustomArtworkState));
  }, [show?.id]);

  useEffect(() => {
    setFallbackThumbnails([]);

    const hasStoredArtwork = Boolean(
      show?.poster
      || show?.backdrop
      || show?.posterCandidates?.length
      || show?.backdropCandidates?.length,
    );
    const episodeFiles = show?.episodeFiles
      ?.slice()
      .sort((a, b) => a.season - b.season || a.episode - b.episode) || [];
    const thumbnailEpisode = episodeFiles.find((file) =>
      getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress,
    ) || episodeFiles[0];
    if (!thumbnailEpisode?.filePath) return;

    let cancelled = false;
    const progress = getProgressState(thumbnailEpisode.filePath, thumbnailEpisode.localMetadata?.durationSeconds);
    const preferredTime = progress.position > 10
      ? formatThumbnailTime(progress.position, progress.duration)
      : '00:03:00';
    const times = hasStoredArtwork ? [preferredTime] : Array.from(new Set([
      progress.position > 10 ? formatThumbnailTime(progress.position, progress.duration) : '',
      '00:03:00',
      '00:01:00',
      '00:00:10',
    ].filter(Boolean)));

    void Promise.all(times.map((time) =>
      desktopApi.getThumbnail(thumbnailEpisode.filePath, time)
        .then(({ url }) => url)
        .catch(() => ''),
    )).then((urls) => {
      if (!cancelled) setFallbackThumbnails(urls.filter(Boolean));
    });

    return () => {
      cancelled = true;
    };
  }, [show?.backdrop, show?.backdropCandidates?.length, show?.episodeFiles, show?.id, show?.poster, show?.posterCandidates?.length]);

  useEffect(() => {
    if (!show?.id) return;
    const ordered = (show.episodeFiles || []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
    const currentIndex = Math.max(0, ordered.findIndex((file) => {
      const progress = getProgressState(file.filePath, file.localMetadata?.durationSeconds);
      return progress.inProgress || !progress.watched;
    }));
    const timers = ordered.slice(currentIndex, currentIndex + 3).map((file, index) => window.setTimeout(() => {
      void desktopApi.getMediaSegments({ mediaId: show.id, season: file.season, episode: file.episode }).catch(() => undefined);
    }, 100 + index * 150));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [show?.episodeFiles, show?.id]);

  // refreshLibrary() updates the item, but the artwork snapshot captured in
  // router state when navigating in takes precedence over it inside
  // posterSources()/backdropSources(). Dropping that snapshot is what makes a
  // newly applied poster or cover appear immediately instead of only after
  // reopening the title.
  const handleArtworkSaved = useCallback(async () => {
    setLibraryActionError('');
    try {
      await refreshLibrary();
    } catch (error) {
      setLibraryActionError(libraryMutationMessage(error));
      return;
    }
    const routeState = (location.state || {}) as Record<string, unknown>;
    if (!routeState.artwork) return;
    const { artwork: _staleArtwork, ...rest } = routeState;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: rest });
  }, [location.pathname, location.search, location.state, navigate, refreshLibrary]);

  if (!show) {
    return (
      <div className="loom-page h-full overflow-y-auto">
        <div className="loom-frame page-bottom-safe pt-6">
          <Skeleton className="h-[400px] w-full rounded-lg" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const episodesForSeason = (seasonNum: number): EpisodeMeta[] =>
    (show.episodes || [])
      .filter((e) => e.season === seasonNum)
      .sort((a, b) => a.number - b.number);

  const findEpisodeFile = (season: number, episode: number): string | null =>
    show.episodeFiles?.find((ef) => ef.season === season && ef.episode === episode)?.filePath || null;

  const cleanEpisodeTitle = (filePath: string, _season: number, episode: number): string => {
    const name = filePath.split(/[\\/]/).pop() || `Episode ${episode}`;
    return name
      .replace(/\.[^.]+$/, '')
      .replace(/[Ss]0*\d{1,2}[._ -]*[Ee]0*\d{1,3}/i, '')
      .replace(new RegExp(`^(episode|ep|e)?\\s*0*${episode}\\b`, 'i'), '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Episode ${episode}`;
  };

  const episodesWithFilesForSeason = (seasonNum: number): EpisodeMeta[] => {
    const byNumber = new Map<number, EpisodeMeta>();

    episodesForSeason(seasonNum).forEach((ep) => byNumber.set(ep.number, ep));

    (show.episodeFiles || [])
      .filter((file) => file.season === seasonNum)
      .forEach((file) => {
        const existing = byNumber.get(file.episode);
        if (!existing) {
          byNumber.set(file.episode, {
            season: seasonNum,
            number: file.episode,
            title: cleanEpisodeTitle(file.filePath, seasonNum, file.episode),
            summary: '',
            still: '',
            rating: 0,
            airDate: '',
          });
        } else if (!existing.title) {
          byNumber.set(file.episode, {
            ...existing,
            title: cleanEpisodeTitle(file.filePath, seasonNum, file.episode),
          });
        }
      });

    return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
  };

  const visibleSeasons = (show.seasons || []).filter((season) => {
    const localFileCount = show.episodeFiles?.filter((ef) => ef.season === season.number).length || 0;
    const mergedEpisodeCount = episodesWithFilesForSeason(season.number).length;
    return localFileCount > 0 || mergedEpisodeCount > 0;
  });

  const playerEpisodes = visibleSeasons.flatMap((season) => episodesWithFilesForSeason(season.number));

  // Specials are displayed separately, but should not become the default
  // Play/Resume target for the main series. They remain available when the
  // Specials season is opened or when playback is explicitly started there.
  const orderedEpisodeFilesForPlayback = show.episodeFiles
    ?.slice()
    .sort((a, b) => {
      const specialOrder = Number(a.season === 0) - Number(b.season === 0);
      return specialOrder || a.season - b.season || a.episode - b.episode;
    });

  const firstPlayableEpisode = orderedEpisodeFilesForPlayback
    ?.find((file) => file.season > 0 && Boolean(file.filePath))
    || orderedEpisodeFilesForPlayback?.find((file) => Boolean(file.filePath));

  const resumeEpisode = orderedEpisodeFilesForPlayback
    ?.find((file) => getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress);

  const nextEpisode = orderedEpisodeFilesForPlayback
    ?.find((file) => !getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched);

  const heroEpisode = resumeEpisode || nextEpisode || firstPlayableEpisode || null;
  const canPlayShow = Boolean(onPlay && heroEpisode?.filePath);
  const inMyList = lists.some((entry) => entry.mediaId === show.id && (entry.kind === 'watchlist' || entry.kind === 'favorite'));
  const isRemoteContent = isRemoteStremioShow || Boolean(routeCatalogItem);
  const watchedEntryKeys = isRemoteContent
    ? [discoverWatchedKey({ id: show.id, type: routeCatalogItem?.type || (kind === 'anime' ? 'anime' : 'tv'), source: routeCatalogItem?.source })]
    : localWatchedKeysForItem(show);
  const episodeFiles = show.episodeFiles || [];
  const watchedByProgress = !isRemoteContent
    && episodeFiles.length > 0
    && episodeFiles.every((file) => getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched);
  const isWatched = watchedByProgress || (watchedEntryKeys.length > 0 && watchedEntryKeys.every((key) => watchedKeys.has(key)));
  const heroIsResume = Boolean(resumeEpisode);
  const heroProgress = heroEpisode
    ? getProgressState(heroEpisode.filePath, heroEpisode.localMetadata?.durationSeconds)
    : { position: 0, duration: 0, fraction: 0, watched: false, inProgress: false };
  const heroProgressPercent = Math.min(100, Math.max(0, heroProgress.fraction * 100));
  const heroEpisodeLabel = heroEpisode ? epCode(heroEpisode.season, heroEpisode.episode) : '';
  const heroProgressCopy = heroProgress.duration > 0
    ? `${formatShortMinutes(heroProgress.position)} of ${formatShortMinutes(heroProgress.duration)}`
    : '';
  const firstEpisodeStill = show.episodes
    ?.find((episode) => Boolean(episode.still))?.still || '';
  const sourceArtwork = routeState?.artwork;
  const generatedArtwork = uniqueArtworkSources(firstEpisodeStill, fallbackThumbnails);
  const heroArtwork = uniqueArtworkSources(
    customArtwork.cover || '',
    backdropSources(show, sourceArtwork, generatedArtwork),
  );
  const posterArtwork = uniqueArtworkSources(
    customArtwork.thumbnail || customArtwork.poster || '',
    posterSources(show, sourceArtwork, generatedArtwork),
  );
  const officialPosterArtwork = uniqueArtworkSources(
    show.posterCandidates,
    show.poster,
    sourceArtwork?.posterCandidates,
    sourceArtwork?.poster,
  );
  const officialCoverArtwork = uniqueArtworkSources(
    show.backdropCandidates,
    show.backdrop,
    sourceArtwork?.backdropCandidates,
    sourceArtwork?.backdrop,
  );
  const playerArtwork = {
    logo: logoSources(show, sourceArtwork)[0] || '',
    logoCandidates: logoSources(show, sourceArtwork),
    poster: posterArtwork[0] || show.poster,
    posterCandidates: posterArtwork,
    backdrop: heroArtwork[0] || show.backdrop,
    backdropCandidates: heroArtwork,
    rating: show.rating,
  };
  const handlePlayEpisode = (season: number, episode: number) => {
    const filePath = findEpisodeFile(season, episode);
    if (!filePath || !onPlay) return;
    const episodeSubtitles = show.episodeFiles?.find((file) =>
      file.filePath === filePath && file.season === season && file.episode === episode,
    )?.subtitles;
    onPlay(filePath, show.title, episodeSubtitles || show.subtitles, playerEpisodes, show.episodeFiles, season, episode, show.id, playerArtwork);
  };

  const handlePlayShow = () => {
    if (!heroEpisode || !onPlay) return;
    onPlay(
      heroEpisode.filePath,
      show.title,
      heroEpisode.subtitles || show.subtitles,
      playerEpisodes,
      show.episodeFiles,
      heroEpisode.season,
      heroEpisode.episode,
      show.id,
      playerArtwork,
    );
  };

  const sortedEpisodeFilesForSeason = (seasonNum: number) => (show.episodeFiles || [])
    .filter((file) => file.season === seasonNum && Boolean(file.filePath))
    .sort((a, b) => a.episode - b.episode);

  const getSeasonPlaybackEpisode = (seasonNum: number) => {
    const seasonFiles = sortedEpisodeFilesForSeason(seasonNum);
    return seasonFiles.find((file) =>
      getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress,
    )
      || seasonFiles.find((file) =>
        !getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched,
      )
      || seasonFiles[0]
      || null;
  };

  const handlePlaySeason = (seasonNum: number) => {
    const targetEpisode = getSeasonPlaybackEpisode(seasonNum);
    if (!targetEpisode || !onPlay) return;
    onPlay(
      targetEpisode.filePath,
      show.title,
      targetEpisode.subtitles || show.subtitles,
      playerEpisodes,
      show.episodeFiles,
      seasonNum,
      targetEpisode.episode,
      show.id,
      playerArtwork,
    );
  };

  const sourceRoute = routeState?.from?.startsWith('/discover')
    ? routeState.from
    : routeState?.fromDiscover || isRemoteStremioShow
      ? getCachedDiscoverReturnRoute()
      : routeState?.from;
  const fallbackRoute = kind === 'anime' ? '/anime' : '/tv';
  const backTarget = sourceRoute && !sourceRoute.startsWith('/anime/') && !sourceRoute.startsWith('/tv/')
    ? sourceRoute
    : fallbackRoute;
  const handleBack = () => navigate(backTarget);


  return (
    <div className={`loom-page loom-detail-page h-full overflow-y-auto ${theme.homeStyle === 'modern' ? 'loom-detail-page-modern' : ''}`}>
      {/* Hero backdrop */}
      <div className="loom-detail-cover relative h-[45vh] w-full overflow-hidden">
        <div className="loom-detail-cover-image absolute inset-y-0 left-0 right-0 mx-auto w-full max-w-[var(--loom-frame-max-width)]">
          <SafeArtwork
            src={heroArtwork}
            placeholderSrc={fallbackThumbnails[0] || ''}
            alt={show.title}
            className="h-full w-full"
            imgClassName="object-cover"
            priority
            fallback={<div className="h-full w-full" />}
          />
        </div>
        <div className="loom-detail-hero-fade absolute inset-0" />
        {libraryActionError ? <div role="alert" className="absolute inset-x-6 bottom-4 z-20 rounded-lg bg-red-950/85 px-3 py-2 text-sm text-red-100">{libraryActionError}</div> : null}
        {canManageProfiles && !isRemoteStremioShow && <ArtworkEditorControls
          mediaId={show.id}
          legacyStorageKey={CUSTOM_ARTWORK_KEY}
          onCustomArtworkChange={setCustomArtwork}
          onSaved={handleArtworkSaved}
          officialThumbnailSources={officialPosterArtwork}
          officialCoverSources={officialCoverArtwork}
          fallbackFrameSource={generatedArtwork[0] || ''}
          revealPath={show.filePath}
          onFetchOfficialArtwork={(target) => desktopApi.refreshOfficialArtwork(show.id, target)}
          onFetchOfficialArtworkCandidates={() => desktopApi.getOfficialMetadataCandidates(show.id)}
          onApplyOfficialArtworkCandidate={(candidate, target) => desktopApi.applyOfficialMetadata(show.id, candidate, target)}
          refreshMetadataState={metadataRefreshState}
          onRefreshIncompleteMetadata={handleRefreshIncompleteMetadata}
        />}
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back"
          className="loom-detail-back loom-no-drag fixed top-6 z-50 flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-3 text-sm text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
        >
          <ChevronRight className="w-5 h-5 rotate-180" />
          <span className="loom-detail-back-label">Back</span>
        </button>

        <div className="loom-detail-hero-content-wrap absolute bottom-0 left-0 right-0">
          <div className="loom-detail-hero-content mx-auto flex w-full max-w-[var(--loom-frame-max-width)] items-end gap-6 p-8">
          <div className="loom-detail-hero-identity flex min-w-0 flex-1 items-end gap-6">
          <SafeArtwork
            src={posterArtwork}
            placeholderSrc={fallbackThumbnails[0] || ''}
            alt={show.title}
            className="loom-poster-frame hidden aspect-[2/3] w-28 shrink-0 rounded-lg shadow-xl md:block"
            imgClassName="object-cover"
            priority
            fallback={
              <div className="flex h-full w-full items-center justify-center p-2">
                <span className="line-clamp-4 text-center text-[10px] font-medium leading-tight text-white/60">
                  {show.title}
                </span>
              </div>
            }
          />
          <div className="loom-detail-hero-info min-w-0 flex-1">
            <h1 className="text-4xl font-semibold text-white">{show.title}</h1>
            <HeroMetadata item={show} />
          </div>
          </div>
          <div className="loom-detail-hero-controls flex shrink-0 items-center gap-[6px]">
          {show.trailerUrl && <Button
            variant="outline"
            onClick={() => setTrailerOpen(true)}
            className="h-12 gap-2 rounded-full border-white/25 bg-white/10 px-4 text-white backdrop-blur-md hover:bg-white/20 hover:text-white"
          >
            <Play className="h-4 w-4 fill-current" />
            Trailer
          </Button>}
          {canPlayShow && (
            <Button
              onClick={handlePlayShow}
              aria-label={heroIsResume ? `Resume ${heroEpisodeLabel}` : `Play ${heroEpisodeLabel}`}
              className="loom-detail-hero-play relative h-14 shrink-0 overflow-hidden rounded-lg bg-[var(--loom-accent)] px-6 text-base font-semibold text-[var(--loom-accent-foreground)] shadow-[0_16px_38px_rgba(0,0,0,0.38)] hover:bg-[var(--loom-accent-hover)] gap-3"
            >
              {heroProgressPercent > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-black/20"
                  style={{ width: `${heroProgressPercent}%` }}
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <Play className="h-7 w-7 fill-current" />
                <span className="loom-detail-hero-play-label flex min-w-28 flex-col items-start leading-tight">
                  <span>{heroIsResume ? 'Resume' : 'Play'}</span>
                  <span className="text-[11px] font-medium text-[var(--loom-accent-foreground-muted)]">
                    {heroIsResume && heroProgressCopy ? `${heroEpisodeLabel} · ${heroProgressCopy}` : heroEpisodeLabel}
                  </span>
                </span>
              </span>
            </Button>
          )}
            <DetailHeroActions
              canBookmark={!isRemoteContent}
              inMyList={inMyList}
              watched={isWatched}
              onToggleList={() => void (async () => {
                await setListEntry(show.id, 'watchlist', !inMyList);
                if (inMyList) await setListEntry(show.id, 'favorite', false);
              })()}
              onToggleWatched={() => {
                if (routeCatalogItem) cacheWatchedDiscoverItem(routeCatalogItem);
                const present = !isWatched;
                if (!present && watchedByProgress) void resetProgress(localProgressPathsForItem(show));
                void setWatchedEntries(watchedEntryKeys, present);
              }}
            />
          </div>
          </div>
        </div>
      </div>

      <div className="loom-detail-body loom-frame">
      <div className="loom-detail-content page-bottom-safe-lg p-8">
        {!shouldOpenDetailsFirst && <div
          className="mb-6 border-b border-[var(--loom-panel-border)]"
          role="tablist"
          aria-label="Title information"
        >
          <SharedListHighlight activeId={activeDetailTab} followPointer={false} className="loom-detail-tabs loom-shared-highlight-list flex items-center gap-8">
          {(['episodes', 'details'] as const).map((tab) => {
            const isActive = activeDetailTab === tab;
            const label = tab === 'episodes' ? 'Episodes' : 'Details';
            return (
              <button
                key={tab}
                id={`detail-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`detail-panel-${tab}`}
                onClick={() => setActiveDetailTab(tab)}
                data-shared-highlight-item
                data-shared-highlight-id={tab}
                className={`relative z-10 -mb-px border-b-2 pb-3 pt-1 text-sm font-semibold uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${isActive
                  ? 'border-[var(--loom-text)] text-[var(--loom-text)]'
                  : 'border-transparent text-[var(--loom-muted)] hover:text-[var(--loom-text)]'
                }`}
              >
                {label}
              </button>
            );
          })}
          </SharedListHighlight>
        </div>}

        {activeDetailTab === 'episodes' && !shouldOpenDetailsFirst && (
        <section
          id="detail-panel-episodes"
          role="tabpanel"
          aria-labelledby="detail-tab-episodes"
        >
          {visibleSeasons.length === 0 ? (
            <p className="text-[var(--loom-muted)]">No season information available. Try scanning the library.</p>
          ) : (
            <SharedListHighlight activeId={expandedSeason === null ? null : String(expandedSeason)} className="loom-shared-highlight-season-cards space-y-2">
              {visibleSeasons.map((season) => {
                const seasonEps = episodesWithFilesForSeason(season.number);
                const seasonTitle = seasonDisplayTitle(season.number, season.title);
                const seasonFiles = sortedEpisodeFilesForSeason(season.number);
                const fileCount = seasonFiles.length;
                const hasFiles = fileCount > 0;
                const seasonIsCompleted = hasFiles && seasonFiles.every((file) =>
                  getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched,
                );
                const isExpanded = expandedSeason === season.number;
                const seasonPlaybackEpisode = getSeasonPlaybackEpisode(season.number);
                const seasonProgress = seasonPlaybackEpisode
                  ? getProgressState(seasonPlaybackEpisode.filePath, seasonPlaybackEpisode.localMetadata?.durationSeconds)
                  : null;
                const seasonIsResume = Boolean(seasonProgress?.inProgress);
                const seasonProgressPercent = seasonProgress
                  ? Math.min(100, Math.max(0, seasonProgress.fraction * 100))
                  : 0;

                return (
                  <div key={season.number} className="loom-season-accordion overflow-hidden rounded-lg">
                    <div className="relative">
                    <button
                      type="button"
                      onClick={() => toggleSeason(season.number)}
                      aria-expanded={isExpanded}
                      aria-controls={`season-${season.number}-episodes`}
                      data-shared-highlight-item
                      data-shared-highlight-id={String(season.number)}
                      className={`relative z-10 flex w-full items-center text-left p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${hasFiles ? 'pr-28' : ''}`}
                    >
                      <span className="flex items-center gap-3">
                        <span className="text-[var(--loom-text)]">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-[var(--loom-muted)]" /> : <ChevronRight className="h-4 w-4 text-[var(--loom-muted)]" />}
                        </span>
                        <span className="font-medium text-[var(--loom-text)]">{seasonTitle}</span>
                        <span className="text-sm text-[var(--loom-muted)]">
                          {seasonEps.length > 0 ? `${seasonEps.length} episodes` : `${season.episodeCount || fileCount} episodes`}
                        </span>
                      </span>
                    </button>
                      {hasFiles && (
                        <Button
                          size="sm"
                          disabled={seasonIsCompleted}
                          onClick={seasonIsCompleted ? undefined : () => handlePlaySeason(season.number)}
                          aria-label={seasonIsCompleted ? `${seasonTitle} completed` : `${seasonIsResume ? 'Resume' : 'Play'} ${seasonTitle}`}
                          className={`absolute right-4 top-1/2 z-20 h-7 -translate-y-1/2 overflow-hidden rounded-lg px-3 text-xs gap-1 whitespace-nowrap ${seasonIsCompleted
                            ? 'border border-emerald-400/45 bg-emerald-700 text-white shadow-[0_0_12px_rgba(16,185,129,0.16)] disabled:cursor-default disabled:opacity-100'
                            : 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)]'
                          }`}
                        >
                          {!seasonIsCompleted && seasonIsResume && seasonProgressPercent > 0 && (
                            <span className="pointer-events-none absolute inset-y-0 left-0 bg-black/20" style={{ width: `${seasonProgressPercent}%` }} />
                          )}
                          <span className="relative z-10 flex items-center gap-1">
                            {seasonIsCompleted ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 stroke-[3]" /> : <Play className="h-3 w-3" />}
                            {seasonIsCompleted ? 'Completed' : seasonIsResume ? 'Resume' : 'Play'}
                          </span>
                        </Button>
                      )}
                    </div>

                    {isExpanded && (
                      <SharedListHighlight className="loom-shared-highlight-episodes divide-y divide-[var(--loom-panel-border)]" >
                        <div id={`season-${season.number}-episodes`} className="contents">
                        {seasonEps.length > 0 ? seasonEps.map((episode) => (
                          <EpisodeRow
                            key={episode.number}
                            ep={episode}
                            seriesTitle={show.title}
                            filePath={findEpisodeFile(season.number, episode.number)}
                            seasonNum={season.number}
                            progressTick={progressTick}
                            durationHint={show.episodeFiles?.find((file) => file.season === season.number && file.episode === episode.number)?.localMetadata?.durationSeconds}
                            onPlay={() => handlePlayEpisode(season.number, episode.number)}
                          />
                        )) : show.episodeFiles
                          ?.filter((file) => file.season === season.number)
                          .sort((left, right) => left.episode - right.episode)
                          .map((file) => (
                            <EpisodeRow
                              key={file.episode}
                              ep={{ season: season.number, number: file.episode, title: cleanEpisodeTitle(file.filePath, season.number, file.episode), summary: '', still: '', rating: 0, airDate: '' }}
                              seriesTitle={show.title}
                              filePath={file.filePath}
                              seasonNum={season.number}
                              progressTick={progressTick}
                              durationHint={file.localMetadata?.durationSeconds}
                              onPlay={() => onPlay && onPlay(file.filePath, show.title, file.subtitles || show.subtitles, playerEpisodes, show.episodeFiles, season.number, file.episode, show.id, playerArtwork)}
                            />
                          ))}
                        </div>
                      </SharedListHighlight>
                    )}
                  </div>
                );
              })}
            </SharedListHighlight>
          )}
        </section>
        )}

        {(activeDetailTab === 'details' || shouldOpenDetailsFirst) && (
          <div
            id="detail-panel-details"
            role={shouldOpenDetailsFirst ? 'region' : 'tabpanel'}
            aria-label={shouldOpenDetailsFirst ? 'Title details' : undefined}
            aria-labelledby={shouldOpenDetailsFirst ? undefined : 'detail-tab-details'}
            className="space-y-8"
          >
            {show.summary && (
              <section className="loom-detail-summary">
                <h3 className="mb-3 text-lg font-semibold text-[var(--loom-text)]">Summary</h3>
                <p className="whitespace-pre-line text-[var(--loom-muted)] leading-relaxed">{show.summary}</p>
              </section>
            )}

            {detailsReady && show.cast.length > 0 && (
              <section>
                <h3 className="mb-3 text-lg font-semibold text-[var(--loom-text)]">Cast</h3>
                {kind === 'anime' ? (
                  <AnimeCreditRows credits={show.cast.slice(0, 20)} />
                ) : (
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {show.cast.slice(0, 12).map((actor) => (
                      <div key={actor.name} className="w-20 flex-shrink-0 text-center">
                        <Avatar className="mx-auto mb-2 h-16 w-16">
                          {actor.image ? <AvatarImage src={actor.image} alt={actor.name} /> : <AvatarFallback className="bg-[var(--loom-surface-3)] text-xs text-[var(--loom-text)]">{actor.name.charAt(0)}</AvatarFallback>}
                        </Avatar>
                        <p className="truncate text-xs text-[var(--loom-text)]">{actor.name}</p>
                        <p className="truncate text-xs text-[var(--loom-muted)]">{actor.character}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
      </div>
      <TrailerDialog
        open={trailerOpen}
        title={show.title}
        trailerUrl={show.trailerUrl}
        onClose={() => setTrailerOpen(false)}
      />
    </div>
  );
}

function EpisodeRow({
  ep,
  seriesTitle,
  filePath,
  onPlay,
  seasonNum = 1,
  durationHint = 0,
  progressTick,
}: {
  ep: EpisodeMeta;
  seriesTitle: string;
  filePath: string | null;
  onPlay: () => void;
  seasonNum?: number;
  durationHint?: number;
  progressTick: number;
}) {
  const [imgError, setImgError] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImgError(false);
    setThumbnailUrl(null);

    if (!filePath) return () => {
      cancelled = true;
    };

    void desktopApi.getThumbnail(filePath, '00:03:00')
      .then(({ url }) => {
        if (!cancelled) setThumbnailUrl(url);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(ep.number).padStart(2, '0')}`;
  const displayTitle = episodeTitleDisplay(ep.title, seriesTitle, seasonNum, ep.number);
  const episodeAirDate = formatEpisodeAirDate(ep.airDate);
  const episodeRating = Number.isFinite(ep.rating) && ep.rating > 0 ? ep.rating : 0;
  const progress = getProgressState(filePath, durationHint);
  const isResumable = progress.inProgress && !progress.watched;
  const remainingCopy = progress.duration > 0
    ? formatShortMinutes(Math.max(0, progress.duration - progress.position))
    : '';
  // The badge and the resume bar are the visual channel; this is the same
  // state spoken aloud, so the row is not silent about it to a screen reader.
  const watchStatusCopy = progress.watched
    ? 'Watched'
    : isResumable
      ? `Partly watched${remainingCopy ? `, ${remainingCopy} left` : ''}`
      : '';
  void progressTick;

  return (
    <button
      type="button"
      data-shared-highlight-item
      data-shared-highlight-id={`${seasonNum}-${ep.number}`}
      className="group relative z-10 flex w-full items-center gap-4 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
      onClick={onPlay}
      aria-label={`${isResumable ? 'Resume' : 'Play'} ${epLabel}: ${displayTitle}${episodeAirDate ? `. Released ${episodeAirDate}` : ''}${watchStatusCopy ? `. ${watchStatusCopy}` : ''}`}
    >
      {/* Thumbnail. Watch state lives here rather than in a right-hand column:
          the still is what the eye lands on when scanning a season. */}
      <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-[var(--loom-surface-3)]">
        {(thumbnailUrl || ep.still) && !imgError ? (
          <img
            src={thumbnailUrl || ep.still}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-mono text-xs text-[var(--loom-faint)]">{epLabel}</span>
          </div>
        )}
        {!progress.watched && (
          <div
            className={`absolute inset-0 flex items-center justify-center transition-[opacity,background-color] ${isResumable
              ? 'bg-black/40 opacity-100'
              : 'bg-black/0 opacity-0 group-hover:bg-black/40 group-hover:opacity-100'
            }`}
          >
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--loom-accent)]">
              <Play className="h-4 w-4 fill-current text-[var(--loom-accent-foreground)]" />
            </span>
          </div>
        )}
        {progress.watched && (
          <span className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded bg-black/55">
            <WatchedSolidIcon
              aria-hidden="true"
              className="h-6 w-6 text-emerald-500 drop-shadow-[0_2px_8px_rgba(0,0,0,0.75)]"
            />
          </span>
        )}
        {/* Partly-watched episodes get a resume bar across the foot of the
            still. Finished ones show the centered completion state instead. */}
        {!progress.watched && progress.inProgress && progress.fraction > 0 && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[7px] bg-[var(--loom-media-track)]">
            <span
              className="block h-full bg-[var(--loom-accent)]"
              style={{ width: `${Math.min(100, Math.max(4, progress.fraction * 100))}%` }}
            />
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-white">{epLabel} - {displayTitle}</p>
            {isResumable && (
              <span
                aria-hidden="true"
                className="inline-flex h-5 shrink-0 items-center rounded-full bg-[var(--loom-accent)] px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--loom-accent-foreground)]"
              >
                Resume
              </span>
            )}
          </div>
          {episodeAirDate && (
            <span className="shrink-0 whitespace-nowrap text-xs text-[var(--loom-faint)]">{episodeAirDate}</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-[var(--loom-muted)]">
            {ep.summary || 'No episode description available.'}
          </p>
          {episodeRating > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--loom-rating-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--loom-rating)]">
              <Star className="h-3 w-3 fill-current" />
              {episodeRating.toFixed(1)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
