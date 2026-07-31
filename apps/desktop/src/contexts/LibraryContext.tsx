import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode, useCallback } from 'react';
import { desktopApi, type LibraryIndexPayload } from '@/lib/desktopApi';
import { migrateLegacyArtwork } from '@/lib/customArtwork';
import { hydrateProgressFromDatabase } from '@/lib/progress';
import { useProfiles } from './ProfileContext';

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
  /** Present only on lightweight catalog cards. Full details are fetched on demand. */
  catalogRevision?: number;
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
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
}

export interface LocalMediaDetails {
  fileSize?: number;
  modifiedAtMs?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  bitrateKbps?: number;
  container?: string;
  chapters?: { startMs: number; endMs: number; title: string }[];
}

export interface TVShow extends MediaItem {
  seasons: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
}

export type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';

export interface LibraryFolderGroups {
  movies: string[];
  tvShows: string[];
  anime: string[];
  others: string[];
}

export interface LibraryFolderStatus {
  path: string;
  kind: LibraryFolderKind;
  state: 'available' | 'unavailable';
  isNetworkLike: boolean;
  checkedAt: number;
  message: string;
}

interface LibraryState {
  movies: MediaItem[];
  tvShows: TVShow[];
  animeShows: TVShow[];
  libraryFolders: string[];
  libraryFolderGroups: LibraryFolderGroups;
  libraryFolderStatuses: LibraryFolderStatus[];
  isScanning: boolean;
  scanProgress: number;
  isLoading: boolean;
  isStartupPrepared: boolean;
  autoSyncIntervalHours: number;
  catalogRevision: number | null;
  catalogTransport: 'compact' | 'legacy';
}

type LibraryAction =
  | {
      type: 'SET_LIBRARY_DATA';
      payload: {
        movies?: MediaItem[];
        tvShows?: TVShow[];
        animeShows?: TVShow[];
        libraryFolders?: string[];
        libraryFolderGroups?: Partial<LibraryFolderGroups>;
        libraryFolderStatuses?: LibraryFolderStatus[];
        catalogRevision?: number | null;
        catalogTransport?: 'compact' | 'legacy';
      };
    }
  | { type: 'SET_MOVIES'; payload: MediaItem[] }
  | { type: 'SET_TV_SHOWS'; payload: TVShow[] }
  | { type: 'SET_ANIME_SHOWS'; payload: TVShow[] }
  | { type: 'SET_LIBRARY_FOLDERS'; payload: string[] }
  | { type: 'SET_LIBRARY_FOLDER_GROUPS'; payload: LibraryFolderGroups }
  | { type: 'SET_SCANNING'; payload: boolean }
  | { type: 'SET_SCAN_PROGRESS'; payload: number }
  | { type: 'SET_SCAN_STATE'; payload: { isScanning: boolean; progress: number } }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_STARTUP_PREPARED'; payload: boolean }
  | { type: 'SET_AUTO_SYNC_INTERVAL_HOURS'; payload: number };

const initialState: LibraryState = {
  movies: [],
  tvShows: [],
  animeShows: [],
  libraryFolders: [],
  libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] },
  libraryFolderStatuses: [],
  isScanning: false,
  scanProgress: 0,
  isLoading: true,
  isStartupPrepared: false,
  autoSyncIntervalHours: 12,
  catalogRevision: null,
  catalogTransport: 'legacy',
};

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && valuesEqual(leftRecord[key], rightRecord[key]));
}

function reuseIfEqual<T>(current: T, incoming: T): T {
  return valuesEqual(current, incoming) ? current : incoming;
}

function reconcileMediaItems<T extends MediaItem>(current: T[], incoming: T[]): T[] {
  if (current === incoming) return current;
  const currentById = new Map(current.map((item) => [item.id, item]));
  let changed = current.length !== incoming.length;
  const reconciled = incoming.map((item, index) => {
    const existing = currentById.get(item.id);
    const next = existing && valuesEqual(existing, item) ? existing : item;
    if (next !== current[index]) changed = true;
    return next;
  });
  return changed ? reconciled : current;
}

function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'SET_LIBRARY_DATA': {
      const movies = reconcileMediaItems(state.movies, action.payload.movies || []);
      const tvShows = reconcileMediaItems(state.tvShows, action.payload.tvShows || []);
      const animeShows = reconcileMediaItems(state.animeShows, action.payload.animeShows || []);
      const libraryFolders = reuseIfEqual(state.libraryFolders, action.payload.libraryFolders || []);
      const libraryFolderGroups = reuseIfEqual(
        state.libraryFolderGroups,
        normalizeFolderGroups(action.payload.libraryFolderGroups),
      );
      const libraryFolderStatuses = reuseIfEqual(
        state.libraryFolderStatuses,
        action.payload.libraryFolderStatuses || [],
      );
      const catalogRevision = action.payload.catalogRevision === undefined
        ? state.catalogRevision
        : action.payload.catalogRevision;
      const catalogTransport = action.payload.catalogTransport ?? state.catalogTransport;
      if (
        movies === state.movies
        && tvShows === state.tvShows
        && animeShows === state.animeShows
        && libraryFolders === state.libraryFolders
        && libraryFolderGroups === state.libraryFolderGroups
        && libraryFolderStatuses === state.libraryFolderStatuses
        && catalogRevision === state.catalogRevision
        && catalogTransport === state.catalogTransport
      ) return state;
      return {
        ...state,
        movies,
        tvShows,
        animeShows,
        libraryFolders,
        libraryFolderGroups,
        libraryFolderStatuses,
        catalogRevision,
        catalogTransport,
      };
    }
    case 'SET_MOVIES': {
      const movies = reconcileMediaItems(state.movies, action.payload);
      return movies === state.movies ? state : { ...state, movies };
    }
    case 'SET_TV_SHOWS': {
      const tvShows = reconcileMediaItems(state.tvShows, action.payload);
      return tvShows === state.tvShows ? state : { ...state, tvShows };
    }
    case 'SET_ANIME_SHOWS': {
      const animeShows = reconcileMediaItems(state.animeShows, action.payload);
      return animeShows === state.animeShows ? state : { ...state, animeShows };
    }
    case 'SET_LIBRARY_FOLDERS': {
      const libraryFolders = reuseIfEqual(state.libraryFolders, action.payload);
      return libraryFolders === state.libraryFolders ? state : { ...state, libraryFolders };
    }
    case 'SET_LIBRARY_FOLDER_GROUPS': {
      const libraryFolderGroups = reuseIfEqual(state.libraryFolderGroups, action.payload);
      return libraryFolderGroups === state.libraryFolderGroups ? state : { ...state, libraryFolderGroups };
    }
    case 'SET_SCANNING':
      return state.isScanning === action.payload ? state : { ...state, isScanning: action.payload };
    case 'SET_SCAN_PROGRESS':
      return state.scanProgress === action.payload ? state : { ...state, scanProgress: action.payload };
    case 'SET_SCAN_STATE':
      return state.isScanning === action.payload.isScanning && state.scanProgress === action.payload.progress
        ? state
        : { ...state, isScanning: action.payload.isScanning, scanProgress: action.payload.progress };
    case 'SET_LOADING':
      return state.isLoading === action.payload ? state : { ...state, isLoading: action.payload };
    case 'SET_STARTUP_PREPARED':
      return state.isStartupPrepared === action.payload ? state : { ...state, isStartupPrepared: action.payload };
    case 'SET_AUTO_SYNC_INTERVAL_HOURS':
      return state.autoSyncIntervalHours === action.payload ? state : { ...state, autoSyncIntervalHours: action.payload };
    default:
      return state;
  }
}

function normalizeShows(items: MediaItem[] | undefined): TVShow[] {
  return (items || []).map((item) => item.seasons
    ? item as TVShow
    : { ...item, seasons: [] });
}

interface LibraryContextType {
  state: LibraryState;
  dispatch: React.Dispatch<LibraryAction>;
  scanLibrary: () => Promise<void>;
  fullRescanLibrary: () => Promise<void>;
  refreshMetadata: () => Promise<void>;
  addLibraryFolder: (kind?: LibraryFolderKind) => Promise<void>;
  removeLibraryFolder: (folder: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  clearAppData: () => Promise<void>;
  setAutoSyncIntervalHours: (hours: number) => Promise<void>;
  hydrateLibraryItem: (mediaId: string) => Promise<MediaItem | null>;
}

const LibraryContext = createContext<LibraryContextType | undefined>(undefined);

function normalizeFolderGroups(groups?: Partial<LibraryFolderGroups>): LibraryFolderGroups {
  return {
    movies: [...(groups?.movies || [])],
    tvShows: [...(groups?.tvShows || [])],
    anime: [...(groups?.anime || [])],
    others: [...(groups?.others || [])],
  };
}

function hasConfiguredFolders(data: {
  libraryFolders?: string[];
  libraryFolderGroups?: Partial<LibraryFolderGroups>;
}): boolean {
  return Boolean(
    data.libraryFolders?.length
    || data.libraryFolderGroups?.movies?.length
    || data.libraryFolderGroups?.tvShows?.length
    || data.libraryFolderGroups?.anime?.length
    || data.libraryFolderGroups?.others?.length,
  );
}

const DETAIL_CACHE_LIMIT = 32;

function mediaItemFromCatalogCard(
  card: LibraryIndexPayload['movies'][number],
  revision: number,
): MediaItem {
  const playbackReferences = card.playbackReferences || [];
  const firstReference = playbackReferences[0];
  const episodeFiles = playbackReferences
    .filter((reference) => Number.isFinite(reference.season) && Number.isFinite(reference.episode))
    .map((reference) => ({
      season: reference.season as number,
      episode: reference.episode as number,
      filePath: reference.progressKey,
      title: `Episode ${reference.episode}`,
      ...(reference.durationSeconds ? { localMetadata: { durationSeconds: reference.durationSeconds } } : {}),
    }));
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    year: card.year || 0,
    poster: card.poster,
    backdrop: card.backdrop,
    logo: card.logo,
    posterCandidates: card.posterCandidates,
    backdropCandidates: card.backdropCandidates,
    logoCandidates: card.logoCandidates,
    summary: card.summary,
    rating: card.rating,
    genres: card.genres,
    cast: [],
    filePath: firstReference?.progressKey || '',
    lastPlayed: card.lastPlayed,
    seasons: card.seasons,
    episodeFiles,
    ...(episodeFiles.length === 0 && firstReference?.durationSeconds
      ? { localMetadata: { durationSeconds: firstReference.durationSeconds } }
      : {}),
    catalogRevision: revision,
  };
}

function libraryDataFromIndex(index: LibraryIndexPayload) {
  return {
    movies: index.movies.map((item) => mediaItemFromCatalogCard(item, index.revision)),
    tvShows: index.tvShows.map((item) => mediaItemFromCatalogCard(item, index.revision)),
    animeShows: index.animeShows.map((item) => mediaItemFromCatalogCard(item, index.revision)),
    libraryFolders: index.libraryFolders,
    libraryFolderGroups: index.libraryFolderGroups,
    libraryFolderStatuses: index.libraryFolderStatuses,
    catalogRevision: index.revision,
    catalogTransport: 'compact' as const,
  };
}

function findItemInState(state: LibraryState, mediaId: string): MediaItem | null {
  return [...state.movies, ...state.tvShows, ...state.animeShows].find((item) => item.id === mediaId) || null;
}

function rememberBoundedDetail(cache: Map<string, MediaItem>, key: string, item: MediaItem): void {
  cache.delete(key);
  cache.set(key, item);
  while (cache.size > DETAIL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { activeProfile } = useProfiles();
  const [state, dispatch] = useReducer(libraryReducer, initialState);
  const isScanningRef = useRef(false);
  const hasConfiguredFoldersRef = useRef(false);
  const detailCacheRef = useRef(new Map<string, MediaItem>());
  const detailRequestsRef = useRef(new Map<string, Promise<MediaItem | null>>());
  const legacyFallbackCountRef = useRef(0);

  const applyLibraryData = useCallback((data: {
    movies?: MediaItem[];
    tvShows?: MediaItem[];
    animeShows?: MediaItem[];
    libraryFolders?: string[];
    libraryFolderGroups?: Partial<LibraryFolderGroups>;
    libraryFolderStatuses?: LibraryFolderStatus[];
    catalogRevision?: number | null;
    catalogTransport?: 'compact' | 'legacy';
  }) => {
    dispatch({
      type: 'SET_LIBRARY_DATA',
      payload: {
        ...data,
        tvShows: normalizeShows(data.tvShows),
        animeShows: normalizeShows(data.animeShows),
      },
    });
  }, []);

  const applyCompactIndex = useCallback((index: LibraryIndexPayload) => {
    const compact = libraryDataFromIndex(index);
    applyLibraryData(compact);
    return compact;
  }, [applyLibraryData]);

  const loadPrimaryCatalog = useCallback(async () => {
    const index = await desktopApi.getLibraryIndex();
    if (index?.catalogVersion === 1) {
      return applyCompactIndex(index);
    }

    legacyFallbackCountRef.current += 1;
    console.warn(`[catalog] Compact index unavailable; using legacy library payload (fallback ${legacyFallbackCountRef.current}).`);
    const legacy = await desktopApi.getLibrary();
    const fallback = { ...legacy, catalogRevision: null, catalogTransport: 'legacy' as const };
    applyLibraryData(fallback);
    return fallback;
  }, [applyCompactIndex, applyLibraryData]);

  const applyScanProgress = useCallback((progress?: { isComplete: boolean; scannedFolders: number; totalFolders: number }) => {
    if (!progress) return;
    const percent = progress.totalFolders > 0
      ? Math.round((progress.scannedFolders / progress.totalFolders) * 100)
      : progress.isComplete ? 100 : 0;
    dispatch({
      type: 'SET_SCAN_STATE',
      payload: {
        isScanning: !progress.isComplete,
        progress: Math.min(100, Math.max(0, percent)),
      },
    });
  }, []);

  const refreshLibrary = async () => {
    try {
      await loadPrimaryCatalog();
    } catch (error) {
      console.error('Failed to load library:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const hydrateLibraryItem = useCallback(async (mediaId: string): Promise<MediaItem | null> => {
    const catalogItem = findItemInState(state, mediaId);
    if (!catalogItem || catalogItem.catalogRevision === undefined || state.catalogRevision === null) return catalogItem;
    const key = `${activeProfile?.id || 'profile:none'}:${state.catalogRevision}:${mediaId}`;
    const cached = detailCacheRef.current.get(key);
    if (cached) {
      rememberBoundedDetail(detailCacheRef.current, key, cached);
      return cached;
    }
    const pending = detailRequestsRef.current.get(key);
    if (pending) return pending;

    const request = desktopApi.getLibraryItem(mediaId)
      .then(async (payload) => {
        if (!payload) {
          legacyFallbackCountRef.current += 1;
          console.warn(`[catalog] Item details unavailable; using legacy library payload (fallback ${legacyFallbackCountRef.current}).`);
          const legacy = await desktopApi.getLibrary();
          const detail = [...legacy.movies, ...legacy.tvShows, ...(legacy.animeShows || [])]
            .find((item) => item.id === mediaId) as MediaItem | undefined;
          if (detail) rememberBoundedDetail(detailCacheRef.current, key, detail);
          return detail || null;
        }
        if (payload.revision !== state.catalogRevision) {
          console.warn('[catalog] Ignored media details from a stale catalog revision.');
          return catalogItem;
        }
        const item = payload.item as MediaItem;
        rememberBoundedDetail(detailCacheRef.current, key, item);
        return item;
      })
      .finally(() => detailRequestsRef.current.delete(key));
    detailRequestsRef.current.set(key, request);
    return request;
  }, [activeProfile?.id, state]);

  const runLibraryScan = async (mode: 'quick' | 'metadata' | 'full') => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;
    dispatch({ type: 'SET_SCANNING', payload: true });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const index = await desktopApi.scanLibrary(mode);
      if (index?.catalogVersion === 1) applyCompactIndex(index);
      else await loadPrimaryCatalog();
    } catch (error) {
      console.error('Failed to scan library:', error);
    } finally {
      isScanningRef.current = false;
      dispatch({ type: 'SET_SCANNING', payload: false });
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const scanLibrary = () => runLibraryScan('quick');
  const refreshMetadata = () => runLibraryScan('metadata');
  const fullRescanLibrary = () => runLibraryScan('full');

  const addLibraryFolder = async (kind: LibraryFolderKind = 'movies') => {
    try {
      const index = await desktopApi.addLibraryFolder(kind);
      if (index?.catalogVersion === 1) applyCompactIndex(index);
    } catch (error) {
      console.error('Failed to add library folder:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const removeLibraryFolder = async (folder: string) => {
    try {
      const index = await desktopApi.removeLibraryFolder(folder);
      applyCompactIndex(index);
    } catch (error) {
      console.error('Failed to remove library folder:', error);
    }
  };

  const clearAppData = async () => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_SCANNING', payload: false });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const index = await desktopApi.clearAppData();
      applyCompactIndex(index);
      dispatch({ type: 'SET_AUTO_SYNC_INTERVAL_HOURS', payload: initialState.autoSyncIntervalHours });
    } catch (error) {
      console.error('Failed to clear app data:', error);
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const setAutoSyncIntervalHours = async (hours: number) => {
    const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 12;
    dispatch({ type: 'SET_AUTO_SYNC_INTERVAL_HOURS', payload: normalizedHours });
    try {
      await desktopApi.saveSettings({ autoSyncIntervalHours: normalizedHours });
    } catch (error) {
      console.error('Failed to save auto sync interval:', error);
    }
  };

  useEffect(() => {
    hasConfiguredFoldersRef.current = hasConfiguredFolders(state);
  }, [state]);

  useEffect(() => {
    return desktopApi.onLibraryScanProgress((progress) => {
      applyScanProgress(progress);
      dispatch({ type: 'SET_LOADING', payload: false });
    });
  }, [applyScanProgress]);

  useEffect(() => {
    let cancelled = false;

    const prepareLibrary = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_STARTUP_PREPARED', payload: false });
      let cached: Awaited<ReturnType<typeof loadPrimaryCatalog>> | null = null;
      try {
        cached = await loadPrimaryCatalog();
        if (cancelled) return;
      } catch (error) {
        console.error('Failed to load library:', error);
      }

      // The cached library is the small startup slice. It is sufficient to
      // render Home and its priority hero; profile progress, settings, artwork
      // migration, and scanning can hydrate the rest without holding the gate.
      if (!cancelled) {
        dispatch({ type: 'SET_LOADING', payload: false });
        dispatch({ type: 'SET_STARTUP_PREPARED', payload: true });
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(() => {
          window.requestIdleCallback(() => resolve(), { timeout: 750 });
        }, 100);
      });
      if (cancelled) return;

      try {
        const [, , settings] = await Promise.all([
          migrateLegacyArtwork().catch((error) => console.error('Artwork migration failed:', error)),
          hydrateProgressFromDatabase().catch((error) => console.error('Progress hydration failed:', error)),
          desktopApi.getSettings().catch(() => null),
        ]);
        if (cancelled) return;
        if (settings?.autoSyncIntervalHours) {
          dispatch({
            type: 'SET_AUTO_SYNC_INTERVAL_HOURS',
            payload: settings.autoSyncIntervalHours,
          });
        }

        if (cached && activeProfile?.type === 'owner' && hasConfiguredFolders(cached)) {
          isScanningRef.current = true;
          dispatch({ type: 'SET_SCANNING', payload: true });
          dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
          try {
            const index = await desktopApi.scanLibrary('quick');
            if (!cancelled && index?.catalogVersion === 1) applyCompactIndex(index);
          } catch (error) {
            console.error('Failed to scan library:', error);
          }
        }
      } finally {
        if (!cancelled) {
          isScanningRef.current = false;
          dispatch({ type: 'SET_SCANNING', payload: false });
        }
      }
    };

    void prepareLibrary();
    return () => {
      cancelled = true;
    };
  }, [activeProfile?.id, activeProfile?.type, applyCompactIndex, loadPrimaryCatalog]);

  useEffect(() => {
    const intervalMs = state.autoSyncIntervalHours * 60 * 60 * 1000;
    const intervalId = window.setInterval(() => {
      if (activeProfile?.type !== 'owner' || isScanningRef.current || !hasConfiguredFoldersRef.current) return;

      void (async () => {
        isScanningRef.current = true;
        dispatch({ type: 'SET_SCANNING', payload: true });
        dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
        try {
          const index = await desktopApi.scanLibrary('quick');
          if (index?.catalogVersion === 1) applyCompactIndex(index);
        } catch (error) {
          console.error('Failed to auto sync library:', error);
        } finally {
          isScanningRef.current = false;
          dispatch({ type: 'SET_SCANNING', payload: false });
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      })();
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [activeProfile?.type, applyCompactIndex, state.autoSyncIntervalHours]);

  useEffect(() => {
    if (!desktopApi.isRemoteLibraryMode() || !activeProfile) return undefined;
    const refreshRemote = () => void loadPrimaryCatalog()
      .catch((error) => console.warn('Shared library refresh failed:', error));
    const intervalId = window.setInterval(refreshRemote, 30_000);
    return () => window.clearInterval(intervalId);
  }, [activeProfile, loadPrimaryCatalog]);

  return (
    <LibraryContext.Provider value={{ state, dispatch, scanLibrary, fullRescanLibrary, refreshMetadata, addLibraryFolder, removeLibraryFolder, refreshLibrary, clearAppData, setAutoSyncIntervalHours, hydrateLibraryItem }}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary() {
  const context = useContext(LibraryContext);
  if (context === undefined) {
    throw new Error('useLibrary must be used within a LibraryProvider');
  }
  return context;
}
