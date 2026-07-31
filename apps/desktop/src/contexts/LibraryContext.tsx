import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode, useCallback } from 'react';
import { desktopApi } from '@/lib/desktopApi';
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
      if (
        movies === state.movies
        && tvShows === state.tvShows
        && animeShows === state.animeShows
        && libraryFolders === state.libraryFolders
        && libraryFolderGroups === state.libraryFolderGroups
        && libraryFolderStatuses === state.libraryFolderStatuses
      ) return state;
      return {
        ...state,
        movies,
        tvShows,
        animeShows,
        libraryFolders,
        libraryFolderGroups,
        libraryFolderStatuses,
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

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { activeProfile } = useProfiles();
  const [state, dispatch] = useReducer(libraryReducer, initialState);
  const isScanningRef = useRef(false);
  const hasConfiguredFoldersRef = useRef(false);

  const applyLibraryData = useCallback((data: {
    movies?: MediaItem[];
    tvShows?: MediaItem[];
    animeShows?: MediaItem[];
    libraryFolders?: string[];
    libraryFolderGroups?: Partial<LibraryFolderGroups>;
    libraryFolderStatuses?: LibraryFolderStatus[];
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
      const data = await desktopApi.getLibrary();
      applyLibraryData(data);
    } catch (error) {
      console.error('Failed to load library:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const runLibraryScan = async (mode: 'quick' | 'metadata' | 'full') => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;
    dispatch({ type: 'SET_SCANNING', payload: true });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const data = await desktopApi.scanLibrary(mode);
      applyLibraryData(data);
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
      const data = await desktopApi.addLibraryFolder(kind);
      if (data) applyLibraryData(data);
    } catch (error) {
      console.error('Failed to add library folder:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const removeLibraryFolder = async (folder: string) => {
    try {
      const data = await desktopApi.removeLibraryFolder(folder);
      applyLibraryData(data);
    } catch (error) {
      console.error('Failed to remove library folder:', error);
    }
  };

  const clearAppData = async () => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_SCANNING', payload: false });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const data = await desktopApi.clearAppData();
      applyLibraryData(data);
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
    return desktopApi.onLibraryScanProgress((_library, progress) => {
      applyScanProgress(progress);
      dispatch({ type: 'SET_LOADING', payload: false });
    });
  }, [applyScanProgress]);

  useEffect(() => {
    let cancelled = false;

    const prepareLibrary = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_STARTUP_PREPARED', payload: false });
      let cached: Awaited<ReturnType<typeof desktopApi.getLibrary>> | null = null;
      try {
        cached = await desktopApi.getLibrary();
        if (cancelled) return;
        applyLibraryData(cached);
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
            const scanned = await desktopApi.scanLibrary('quick');
            if (!cancelled) applyLibraryData(scanned);
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
  }, [activeProfile?.type, applyLibraryData]);

  useEffect(() => {
    const intervalMs = state.autoSyncIntervalHours * 60 * 60 * 1000;
    const intervalId = window.setInterval(() => {
      if (activeProfile?.type !== 'owner' || isScanningRef.current || !hasConfiguredFoldersRef.current) return;

      void (async () => {
        isScanningRef.current = true;
        dispatch({ type: 'SET_SCANNING', payload: true });
        dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
        try {
          const data = await desktopApi.scanLibrary('quick');
          applyLibraryData(data);
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
  }, [activeProfile?.type, applyLibraryData, state.autoSyncIntervalHours]);

  useEffect(() => {
    if (!desktopApi.isRemoteLibraryMode() || !activeProfile) return undefined;
    const refreshRemote = () => void desktopApi.getLibrary()
      .then(applyLibraryData)
      .catch((error) => console.warn('Shared library refresh failed:', error));
    const intervalId = window.setInterval(refreshRemote, 30_000);
    return () => window.clearInterval(intervalId);
  }, [activeProfile, applyLibraryData]);

  return (
    <LibraryContext.Provider value={{ state, dispatch, scanLibrary, fullRescanLibrary, refreshMetadata, addLibraryFolder, removeLibraryFolder, refreshLibrary, clearAppData, setAutoSyncIntervalHours }}>
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
