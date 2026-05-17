import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import { migrateLegacyArtwork } from '@/lib/customArtwork';
import { hydrateProgressFromDatabase } from '@/lib/progress';

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
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
  providerIds?: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
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
  localMetadata?: LocalMediaDetails;
}

export interface LocalMediaDetails {
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  bitrateKbps?: number;
  container?: string;
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

interface LibraryState {
  movies: MediaItem[];
  tvShows: TVShow[];
  animeShows: TVShow[];
  libraryFolders: string[];
  libraryFolderGroups: LibraryFolderGroups;
  isScanning: boolean;
  scanProgress: number;
  isLoading: boolean;
  autoSyncIntervalHours: number;
}

type LibraryAction =
  | { type: 'SET_MOVIES'; payload: MediaItem[] }
  | { type: 'SET_TV_SHOWS'; payload: TVShow[] }
  | { type: 'SET_ANIME_SHOWS'; payload: TVShow[] }
  | { type: 'SET_LIBRARY_FOLDERS'; payload: string[] }
  | { type: 'SET_LIBRARY_FOLDER_GROUPS'; payload: LibraryFolderGroups }
  | { type: 'SET_SCANNING'; payload: boolean }
  | { type: 'SET_SCAN_PROGRESS'; payload: number }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_AUTO_SYNC_INTERVAL_HOURS'; payload: number };

const initialState: LibraryState = {
  movies: [],
  tvShows: [],
  animeShows: [],
  libraryFolders: [],
  libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] },
  isScanning: false,
  scanProgress: 0,
  isLoading: true,
  autoSyncIntervalHours: 12,
};

function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'SET_MOVIES':
      return { ...state, movies: action.payload };
    case 'SET_TV_SHOWS':
      return { ...state, tvShows: action.payload };
    case 'SET_ANIME_SHOWS':
      return { ...state, animeShows: action.payload };
    case 'SET_LIBRARY_FOLDERS':
      return { ...state, libraryFolders: action.payload };
    case 'SET_LIBRARY_FOLDER_GROUPS':
      return { ...state, libraryFolderGroups: action.payload };
    case 'SET_SCANNING':
      return { ...state, isScanning: action.payload };
    case 'SET_SCAN_PROGRESS':
      return { ...state, scanProgress: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_AUTO_SYNC_INTERVAL_HOURS':
      return { ...state, autoSyncIntervalHours: action.payload };
    default:
      return state;
  }
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
  const [state, dispatch] = useReducer(libraryReducer, initialState);
  const isScanningRef = useRef(false);
  const hasConfiguredFoldersRef = useRef(false);

  const applyLibraryData = (data: {
    movies?: MediaItem[];
    tvShows?: TVShow[];
    animeShows?: TVShow[];
    libraryFolders?: string[];
    libraryFolderGroups?: Partial<LibraryFolderGroups>;
  }) => {
    const libraryFolderGroups = normalizeFolderGroups(data.libraryFolderGroups);
    dispatch({ type: 'SET_MOVIES', payload: data.movies || [] });
    dispatch({ type: 'SET_TV_SHOWS', payload: data.tvShows || [] });
    dispatch({ type: 'SET_ANIME_SHOWS', payload: data.animeShows || [] });
    dispatch({ type: 'SET_LIBRARY_FOLDERS', payload: data.libraryFolders || [] });
    dispatch({
      type: 'SET_LIBRARY_FOLDER_GROUPS',
      payload: libraryFolderGroups,
    });
  };

  const applyScanProgress = (progress?: { isComplete: boolean; scannedFolders: number; totalFolders: number }) => {
    if (!progress) return;
    const percent = progress.totalFolders > 0
      ? Math.round((progress.scannedFolders / progress.totalFolders) * 100)
      : progress.isComplete ? 100 : 0;
    dispatch({ type: 'SET_SCANNING', payload: !progress.isComplete });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: Math.min(100, Math.max(0, percent)) });
  };

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
    dispatch({ type: 'SET_SCANNING', payload: true });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      const data = await desktopApi.scanLibrary(mode);
      applyLibraryData(data);
    } catch (error) {
      console.error('Failed to scan library:', error);
    } finally {
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
    isScanningRef.current = state.isScanning;
    hasConfiguredFoldersRef.current = hasConfiguredFolders(state);
  }, [state]);

  useEffect(() => {
    return desktopApi.onLibraryScanProgress((library, progress) => {
      applyLibraryData(library);
      applyScanProgress(progress);
      dispatch({ type: 'SET_LOADING', payload: false });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadFromDevice = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      try {
        await migrateLegacyArtwork();
        await hydrateProgressFromDatabase();
        const cached = await desktopApi.getLibrary();
        if (cancelled) return;
        applyLibraryData(cached);

        const settings = await desktopApi.getSettings().catch(() => null);
        if (!cancelled && settings?.autoSyncIntervalHours) {
          dispatch({
            type: 'SET_AUTO_SYNC_INTERVAL_HOURS',
            payload: settings.autoSyncIntervalHours,
          });
        }

        if (hasConfiguredFolders(cached)) {
          dispatch({ type: 'SET_SCANNING', payload: true });
          const scanned = await desktopApi.scanLibrary('quick');
          if (cancelled) return;
          applyLibraryData(scanned);
        }
      } catch (error) {
        console.error('Failed to load library:', error);
      } finally {
        if (!cancelled) {
          dispatch({ type: 'SET_SCANNING', payload: false });
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      }
    };

    void loadFromDevice();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const intervalMs = state.autoSyncIntervalHours * 60 * 60 * 1000;
    const intervalId = window.setInterval(() => {
      if (isScanningRef.current || !hasConfiguredFoldersRef.current) return;

      void (async () => {
        dispatch({ type: 'SET_SCANNING', payload: true });
        dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
        try {
          const data = await desktopApi.scanLibrary('quick');
          applyLibraryData(data);
        } catch (error) {
          console.error('Failed to auto sync library:', error);
        } finally {
          dispatch({ type: 'SET_SCANNING', payload: false });
          dispatch({ type: 'SET_LOADING', payload: false });
        }
      })();
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [state.autoSyncIntervalHours]);

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
