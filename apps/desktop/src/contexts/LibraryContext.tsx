import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode, useCallback } from 'react';
import { desktopApi, type LibraryIndexPayload } from '@/lib/desktopApi';
import { isRemoteDesktopMode } from '@/lib/remoteDesktop';
import { migrateLegacyArtwork } from '@/lib/customArtwork';
import { hydrateProgressFromDatabase } from '@/lib/progress';
import {
  createLibraryMutationCoordinator,
  type LibraryMutationDomain,
  type LibraryMutationToken,
} from './libraryMutationCoordinator';
import { useProfiles } from './ProfileContext';
import type {
  WireEpisodeFile,
  WireEpisodeMeta,
  WireLocalMediaDetails,
  WireMediaItem,
} from '../shared/desktopProtocol';

export interface MediaItem extends WireMediaItem {
  /** Present only on lightweight catalog cards. Full details are fetched on demand. */
  catalogRevision?: number;
}

export type EpisodeMeta = WireEpisodeMeta;
export type EpisodeFile = WireEpisodeFile;
export type LocalMediaDetails = WireLocalMediaDetails;

export interface TVShow extends MediaItem {
  seasons: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
}

export type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';

export type LibraryMutationOperation =
  | 'refresh'
  | 'scan'
  | 'metadata-refresh'
  | 'full-rescan'
  | 'add-folder'
  | 'remove-folder'
  | 'update-folder'
  | 'rename-folder'
  | 'clear-data'
  | 'auto-sync';

export type LibraryMutationKind = 'catalog' | 'scan' | 'folder' | 'data' | 'settings';
export type LibraryMutationCode =
  | 'LIBRARY_REFRESH_FAILED'
  | 'LIBRARY_SCAN_FAILED'
  | 'LIBRARY_METADATA_REFRESH_FAILED'
  | 'LIBRARY_FULL_RESCAN_FAILED'
  | 'LIBRARY_FOLDER_ADD_FAILED'
  | 'LIBRARY_FOLDER_REMOVE_FAILED'
  | 'LIBRARY_FOLDER_UPDATE_FAILED'
  | 'LIBRARY_FOLDER_RENAME_FAILED'
  | 'LIBRARY_DATA_CLEAR_FAILED'
  | 'LIBRARY_AUTOSYNC_UPDATE_FAILED';

interface LibraryMutationMetadata {
  code: LibraryMutationCode;
  kind: LibraryMutationKind;
  retryable: boolean;
  message: string;
}

const LIBRARY_MUTATION_METADATA: Record<LibraryMutationOperation, LibraryMutationMetadata> = {
  refresh: { code: 'LIBRARY_REFRESH_FAILED', kind: 'catalog', retryable: true, message: 'The library could not be refreshed.' },
  scan: { code: 'LIBRARY_SCAN_FAILED', kind: 'scan', retryable: true, message: 'The library scan could not be completed.' },
  'metadata-refresh': { code: 'LIBRARY_METADATA_REFRESH_FAILED', kind: 'scan', retryable: true, message: 'The metadata refresh could not be completed.' },
  'full-rescan': { code: 'LIBRARY_FULL_RESCAN_FAILED', kind: 'scan', retryable: true, message: 'The full library rescan could not be completed.' },
  'add-folder': { code: 'LIBRARY_FOLDER_ADD_FAILED', kind: 'folder', retryable: true, message: 'The library folder could not be added.' },
  'remove-folder': { code: 'LIBRARY_FOLDER_REMOVE_FAILED', kind: 'folder', retryable: true, message: 'The library folder could not be removed.' },
  'update-folder': { code: 'LIBRARY_FOLDER_UPDATE_FAILED', kind: 'folder', retryable: true, message: 'The library folder could not be updated.' },
  'rename-folder': { code: 'LIBRARY_FOLDER_RENAME_FAILED', kind: 'folder', retryable: true, message: 'The library folder name could not be saved.' },
  'clear-data': { code: 'LIBRARY_DATA_CLEAR_FAILED', kind: 'data', retryable: false, message: 'The library data could not be cleared.' },
  'auto-sync': { code: 'LIBRARY_AUTOSYNC_UPDATE_FAILED', kind: 'settings', retryable: true, message: 'The automatic sync setting could not be saved.' },
};

export class LibraryMutationError extends Error {
  readonly operation: LibraryMutationOperation;
  readonly code: LibraryMutationCode;
  readonly kind: LibraryMutationKind;
  readonly retryable: boolean;
  readonly sanitizedMessage: string;
  readonly cause?: unknown;

  constructor(operation: LibraryMutationOperation, metadata: LibraryMutationMetadata, cause?: unknown) {
    super(metadata.message);
    this.name = 'LibraryMutationError';
    this.operation = operation;
    this.code = metadata.code;
    this.kind = metadata.kind;
    this.retryable = metadata.retryable;
    this.sanitizedMessage = metadata.message;
    this.cause = cause;
  }
}

export interface LibraryFolderGroups {
  movies: string[];
  tvShows: string[];
  anime: string[];
  others: string[];
}

export interface LibraryFolderStatus {
  path: string;
  kind: LibraryFolderKind;
  state: 'available' | 'degraded' | 'unavailable';
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
  autoSyncIntervalHours: 72,
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
  addLibraryFolderPath: (kind: LibraryFolderKind, folder: string) => Promise<void>;
  removeLibraryFolder: (folder: string) => Promise<void>;
  updateLibraryFolder: (folder: string, nextFolder: string, kind: LibraryFolderKind) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  clearAppData: () => Promise<void>;
  setAutoSyncIntervalHours: (hours: number) => Promise<void>;
  hydrateLibraryItem: (mediaId: string) => Promise<MediaItem | null>;
}

export function toLibraryMutationError(operation: LibraryMutationOperation, error: unknown): LibraryMutationError {
  if (error instanceof LibraryMutationError) return error;
  return new LibraryMutationError(operation, LIBRARY_MUTATION_METADATA[operation], error);
}

export function libraryMutationMessage(error: unknown): string {
  return error instanceof LibraryMutationError
    ? error.sanitizedMessage
    : 'The library could not be updated.';
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
  // Existing Home, Continue Watching, detail, and player paths all rely on
  // normal Array iteration/enumeration semantics. Keep this compact shape as
  // a plain enumerable array; rich episode metadata is still hydrated only
  // for the bounded set of opened titles.
  const episodeFiles: EpisodeFile[] = playbackReferences.flatMap((reference) => (
    Number.isFinite(reference.season) && Number.isFinite(reference.episode)
      ? [{
          season: reference.season as number,
          episode: reference.episode as number,
          filePath: reference.progressKey,
          ...(reference.durationSeconds
            ? { localMetadata: { durationSeconds: reference.durationSeconds } }
            : {}),
        }]
      : []
  ));
  const item: MediaItem = {
    id: card.id,
    type: card.type,
    format: card.format,
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
    providerRatings: card.providerRatings,
    contentRatings: card.contentRatings,
    contentRating: card.contentRating,
    streamingProviders: card.streamingProviders,
    originPlatform: card.originPlatform,
    trailerUrl: card.trailerUrl,
    runtime: card.runtime,
    seasonCount: card.seasonCount,
    episodeCount: card.episodeCount,
    genres: card.genres,
    cast: [],
    filePath: firstReference?.progressKey || '',
    lastPlayed: card.lastPlayed,
    seasons: card.seasons,
    ...(episodeFiles.length > 0 ? { episodeFiles } : {}),
    ...(firstReference?.durationSeconds
      ? { localMetadata: { durationSeconds: firstReference.durationSeconds } }
      : {}),
    catalogRevision: revision,
  };

  return item;
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
  const activeProfileId = activeProfile?.id || 'profile:none';
  const activeProfileIdRef = useRef(activeProfileId);
  const libraryProfileIdRef = useRef<string | null>(null);
  const libraryCatalogRevisionRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  const isScanningRef = useRef(false);
  const hasConfiguredFoldersRef = useRef(false);
  const detailCacheRef = useRef(new Map<string, MediaItem>());
  const detailRequestsRef = useRef(new Map<string, Promise<MediaItem | null>>());
  const detailScopeRef = useRef<string | null>(null);
  const detailGenerationRef = useRef(0);
  const legacyFallbackCountRef = useRef(0);
  const libraryMutationCoordinatorRef = useRef(createLibraryMutationCoordinator());
  const autoSyncHoursRef = useRef(state.autoSyncIntervalHours);

  stateRef.current = state;
  activeProfileIdRef.current = activeProfileId;
  autoSyncHoursRef.current = state.autoSyncIntervalHours;

  const beginLibraryMutation = useCallback((domain: LibraryMutationDomain): LibraryMutationToken => {
    return libraryMutationCoordinatorRef.current.begin(domain);
  }, []);

  const isCurrentLibraryMutation = useCallback((token?: LibraryMutationToken): boolean => (
    libraryMutationCoordinatorRef.current.isCurrent(token)
  ), []);

  const clearDetailStateIfScopeChanged = useCallback((catalogRevision: number | null) => {
    const nextScope = `${activeProfileId}:${catalogRevision ?? 'legacy'}`;
    if (detailScopeRef.current === nextScope) return;
    detailScopeRef.current = nextScope;
    detailGenerationRef.current += 1;
    detailCacheRef.current.clear();
    detailRequestsRef.current.clear();
  }, [activeProfileId]);

  const applyLibraryData = useCallback((data: {
    movies?: MediaItem[];
    tvShows?: MediaItem[];
    animeShows?: MediaItem[];
    libraryFolders?: string[];
    libraryFolderGroups?: Partial<LibraryFolderGroups>;
    libraryFolderStatuses?: LibraryFolderStatus[];
    catalogRevision?: number | null;
    catalogTransport?: 'compact' | 'legacy';
  }, mutationToken?: LibraryMutationToken) => {
    if (activeProfileIdRef.current !== activeProfileId) return false;
    if (!isCurrentLibraryMutation(mutationToken)) return false;
    const nextCatalogRevision = data.catalogRevision === undefined
      ? stateRef.current.catalogRevision
      : data.catalogRevision;
    if (
      libraryProfileIdRef.current === activeProfileId
      && typeof libraryCatalogRevisionRef.current === 'number'
      && typeof nextCatalogRevision === 'number'
      && nextCatalogRevision < libraryCatalogRevisionRef.current
    ) {
      console.warn('[catalog] Ignored a library payload from an older catalog revision.');
      return false;
    }
    clearDetailStateIfScopeChanged(nextCatalogRevision);
    libraryProfileIdRef.current = activeProfileId;
    libraryCatalogRevisionRef.current = nextCatalogRevision;
    dispatch({
      type: 'SET_LIBRARY_DATA',
      payload: {
        ...data,
        tvShows: normalizeShows(data.tvShows),
        animeShows: normalizeShows(data.animeShows),
      },
    });
    return true;
  }, [activeProfileId, clearDetailStateIfScopeChanged, isCurrentLibraryMutation]);

  const applyCompactIndex = useCallback((index: LibraryIndexPayload, mutationToken?: LibraryMutationToken) => {
    if (activeProfileIdRef.current !== activeProfileId) return null;
    const compact = libraryDataFromIndex(index);
    return applyLibraryData(compact, mutationToken) ? compact : null;
  }, [activeProfileId, applyLibraryData]);

  const loadPrimaryCatalog = useCallback(async (mutationToken?: LibraryMutationToken) => {
    const requestProfileId = activeProfileId;
    if (!isRemoteDesktopMode()) {
      const library = await desktopApi.getLibrary();
      if (activeProfileIdRef.current !== requestProfileId) return null;
      if (!isCurrentLibraryMutation(mutationToken)) return null;
      const localLibrary = { ...library, catalogRevision: null, catalogTransport: 'legacy' as const };
      return applyLibraryData(localLibrary, mutationToken) ? localLibrary : null;
    }

    const index = await desktopApi.getLibraryIndex();
    if (activeProfileIdRef.current !== requestProfileId) return null;
    if (!isCurrentLibraryMutation(mutationToken)) return null;
    if (index?.catalogVersion === 1) {
      return applyCompactIndex(index, mutationToken);
    }

    legacyFallbackCountRef.current += 1;
    console.warn(`[catalog] Compact index unavailable; using legacy library payload (fallback ${legacyFallbackCountRef.current}).`);
    const legacy = await desktopApi.getLibrary();
    if (activeProfileIdRef.current !== requestProfileId) return null;
    if (!isCurrentLibraryMutation(mutationToken)) return null;
    const fallback = { ...legacy, catalogRevision: null, catalogTransport: 'legacy' as const };
    return applyLibraryData(fallback, mutationToken) ? fallback : null;
  }, [activeProfileId, applyCompactIndex, applyLibraryData, isCurrentLibraryMutation]);

  const applyScanCatalog = useCallback(async (index: LibraryIndexPayload, mutationToken: LibraryMutationToken) => {
    if (isRemoteDesktopMode()) {
      applyCompactIndex(index, mutationToken);
      return;
    }
    await loadPrimaryCatalog(mutationToken);
  }, [applyCompactIndex, loadPrimaryCatalog]);

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
    const mutationToken = beginLibraryMutation('catalog');
    try {
      await loadPrimaryCatalog(mutationToken);
    } catch (error) {
      console.error('Failed to load library:', error);
      throw toLibraryMutationError('refresh', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  useEffect(() => {
    clearDetailStateIfScopeChanged(state.catalogRevision);
  }, [activeProfileId, clearDetailStateIfScopeChanged, state.catalogRevision]);

  const hydrateLibraryItem = useCallback(async (mediaId: string): Promise<MediaItem | null> => {
    const currentState = stateRef.current;
    if (libraryProfileIdRef.current !== activeProfileId) return null;
    // applyLibraryData updates the accepted revision before React commits the
    // reducer state. Do not let a detail request in that short gap restore the
    // previous scope or cache a response under an obsolete revision.
    if (libraryCatalogRevisionRef.current !== currentState.catalogRevision) return null;
    clearDetailStateIfScopeChanged(currentState.catalogRevision);
    const catalogItem = findItemInState(currentState, mediaId);
    if (!catalogItem || catalogItem.catalogRevision === undefined || currentState.catalogRevision === null) return catalogItem;
    const key = `${activeProfileId}:${currentState.catalogRevision}:${mediaId}`;
    const cached = detailCacheRef.current.get(key);
    if (cached) {
      rememberBoundedDetail(detailCacheRef.current, key, cached);
      return cached;
    }
    const pending = detailRequestsRef.current.get(key);
    if (pending) return pending;

    const requestGeneration = detailGenerationRef.current;
    const request: Promise<MediaItem | null> = desktopApi.getLibraryItem(mediaId)
      .then(async (payload) => {
        if (requestGeneration !== detailGenerationRef.current) return null;
        if (!payload) {
          legacyFallbackCountRef.current += 1;
          console.warn(`[catalog] Item details unavailable; using legacy library payload (fallback ${legacyFallbackCountRef.current}).`);
          const legacy = await desktopApi.getLibrary();
          if (requestGeneration !== detailGenerationRef.current) return null;
          const detail = [...legacy.movies, ...legacy.tvShows, ...(legacy.animeShows || [])]
            .find((item) => item.id === mediaId) as MediaItem | undefined;
          if (detail) rememberBoundedDetail(detailCacheRef.current, key, detail);
          return detail || null;
        }
        const latestState = stateRef.current;
        if (payload.revision !== latestState.catalogRevision) {
          console.warn('[catalog] Ignored media details from a stale catalog revision.');
          return findItemInState(latestState, mediaId);
        }
        const item = payload.item as MediaItem;
        rememberBoundedDetail(detailCacheRef.current, key, item);
        return item;
      })
      .finally(() => {
        if (detailRequestsRef.current.get(key) === request) detailRequestsRef.current.delete(key);
      });
    detailRequestsRef.current.set(key, request);
    return request;
  }, [activeProfileId, clearDetailStateIfScopeChanged]);

  const runLibraryScan = async (mode: 'quick' | 'metadata' | 'full') => {
    if (isScanningRef.current) return;
    const mutationToken = beginLibraryMutation('catalog');
    isScanningRef.current = true;
    dispatch({ type: 'SET_SCANNING', payload: true });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const index = await desktopApi.scanLibrary(mode);
      if (index?.catalogVersion === 1) await applyScanCatalog(index, mutationToken);
      else await loadPrimaryCatalog(mutationToken);
    } catch (error) {
      console.error('Failed to scan library:', error);
      const operation = mode === 'quick' ? 'scan' : mode === 'metadata' ? 'metadata-refresh' : 'full-rescan';
      throw toLibraryMutationError(operation, error);
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
    const mutationToken = beginLibraryMutation('catalog');
    try {
      const index = await desktopApi.addLibraryFolder(kind);
      if (index?.catalogVersion === 1) await applyScanCatalog(index, mutationToken);
    } catch (error) {
      console.error('Failed to add library folder:', error);
      throw toLibraryMutationError('add-folder', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const addLibraryFolderPath = async (kind: LibraryFolderKind, folder: string) => {
    const mutationToken = beginLibraryMutation('catalog');
    try {
      const index = await desktopApi.addLibraryFolderPath(kind, folder);
      await applyScanCatalog(index, mutationToken);
    } catch (error) {
      console.error('Failed to add library folder path:', error);
      throw toLibraryMutationError('add-folder', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const removeLibraryFolder = async (folder: string) => {
    const mutationToken = beginLibraryMutation('catalog');
    try {
      const index = await desktopApi.removeLibraryFolder(folder);
      await applyScanCatalog(index, mutationToken);
    } catch (error) {
      console.error('Failed to remove library folder:', error);
      throw toLibraryMutationError('remove-folder', error);
    }
  };

  const updateLibraryFolder = async (folder: string, nextFolder: string, kind: LibraryFolderKind) => {
    const mutationToken = beginLibraryMutation('catalog');
    try {
      const index = await desktopApi.updateLibraryFolder(folder, nextFolder, kind);
      await applyScanCatalog(index, mutationToken);
    } catch (error) {
      console.error('Failed to update library folder:', error);
      throw toLibraryMutationError('update-folder', error);
    }
  };

  const clearAppData = async () => {
    const catalogMutation = beginLibraryMutation('catalog');
    const settingsMutation = beginLibraryMutation('settings');
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_SCANNING', payload: false });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const index = await desktopApi.clearAppData();
      await applyScanCatalog(index, catalogMutation);
      if (isCurrentLibraryMutation(settingsMutation)) {
        dispatch({ type: 'SET_AUTO_SYNC_INTERVAL_HOURS', payload: initialState.autoSyncIntervalHours });
        autoSyncHoursRef.current = initialState.autoSyncIntervalHours;
      }
    } catch (error) {
      console.error('Failed to clear app data:', error);
      throw toLibraryMutationError('clear-data', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const setAutoSyncIntervalHours = async (hours: number) => {
    const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 72;
    const mutationToken = beginLibraryMutation('settings');
    const previousHours = autoSyncHoursRef.current;
    autoSyncHoursRef.current = normalizedHours;
    dispatch({ type: 'SET_AUTO_SYNC_INTERVAL_HOURS', payload: normalizedHours });
    try {
      await desktopApi.saveSettings({ autoSyncIntervalHours: normalizedHours });
    } catch (error) {
      console.error('Failed to save auto sync interval:', error);
      if (isCurrentLibraryMutation(mutationToken)) {
        autoSyncHoursRef.current = previousHours;
        dispatch({ type: 'SET_AUTO_SYNC_INTERVAL_HOURS', payload: previousHours });
      }
      throw toLibraryMutationError('auto-sync', error);
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
      const startupMutation = beginLibraryMutation('catalog');
      try {
        cached = await loadPrimaryCatalog(startupMutation);
        if (cancelled) return;
      } catch (error) {
        const mutationError = toLibraryMutationError('refresh', error);
        console.error(mutationError.code, mutationError.sanitizedMessage, mutationError.cause);
      }

      // Local host mode already loaded the persisted rich snapshot. Remote mode
      // intentionally keeps the compact index and hydrates opened titles only.
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
          const mutationToken = beginLibraryMutation('catalog');
          try {
            const index = await desktopApi.scanLibrary('quick');
            if (!cancelled && index?.catalogVersion === 1) await applyScanCatalog(index, mutationToken);
          } catch (error) {
            const mutationError = toLibraryMutationError('scan', error);
            console.error(mutationError.code, mutationError.sanitizedMessage, mutationError.cause);
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
      // A profile switch can tear down this startup effect while its quick
      // sync is still waiting on the host. Do not leave the old profile's
      // spinner mounted after that request is abandoned.
      if (isScanningRef.current) {
        isScanningRef.current = false;
        dispatch({ type: 'SET_SCANNING', payload: false });
        dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
      }
    };
  }, [activeProfile?.id, activeProfile?.type, applyScanCatalog, beginLibraryMutation, loadPrimaryCatalog]);

  useEffect(() => {
    const intervalMs = state.autoSyncIntervalHours * 60 * 60 * 1000;
    const intervalId = window.setInterval(() => {
      if (activeProfile?.type !== 'owner' || isScanningRef.current || !hasConfiguredFoldersRef.current) return;

      void (async () => {
        isScanningRef.current = true;
        dispatch({ type: 'SET_SCANNING', payload: true });
        dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
        const mutationToken = beginLibraryMutation('catalog');
        try {
          const index = await desktopApi.scanLibrary('quick');
          if (index?.catalogVersion === 1) await applyScanCatalog(index, mutationToken);
        } catch (error) {
          const mutationError = toLibraryMutationError('scan', error);
          console.error(mutationError.code, mutationError.sanitizedMessage, mutationError.cause);
        } finally {
          isScanningRef.current = false;
          dispatch({ type: 'SET_SCANNING', payload: false });
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      })();
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [activeProfile?.type, applyScanCatalog, beginLibraryMutation, state.autoSyncIntervalHours]);

  useEffect(() => {
    if (!desktopApi.isRemoteLibraryMode() || !activeProfile) return undefined;
    const refreshRemote = () => void loadPrimaryCatalog(beginLibraryMutation('catalog'))
      .catch((error) => {
        const mutationError = toLibraryMutationError('refresh', error);
        console.warn(mutationError.code, mutationError.sanitizedMessage, mutationError.cause);
      });
    const intervalId = window.setInterval(refreshRemote, 30_000);
    return () => window.clearInterval(intervalId);
  }, [activeProfile, beginLibraryMutation, loadPrimaryCatalog]);

  return (
    <LibraryContext.Provider value={{ state, dispatch, scanLibrary, fullRescanLibrary, refreshMetadata, addLibraryFolder, addLibraryFolderPath, removeLibraryFolder, updateLibraryFolder, refreshLibrary, clearAppData, setAutoSyncIntervalHours, hydrateLibraryItem }}>
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
