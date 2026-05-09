import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { desktopApi } from '@/lib/desktopApi';

export interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year: number;
  poster: string;
  backdrop: string;
  summary: string;
  rating: number;
  genres: string[];
  cast: { name: string; character: string; image: string }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
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

export interface LibraryState {
  movies: MediaItem[];
  tvShows: TVShow[];
  animeShows: TVShow[];
  libraryFolders: string[];
  isScanning: boolean;
  scanProgress: number;
  isLoading: boolean;
}

type LibraryAction =
  | { type: 'SET_MOVIES'; payload: MediaItem[] }
  | { type: 'SET_TV_SHOWS'; payload: TVShow[] }
  | { type: 'SET_ANIME_SHOWS'; payload: TVShow[] }
  | { type: 'SET_LIBRARY_FOLDERS'; payload: string[] }
  | { type: 'SET_SCANNING'; payload: boolean }
  | { type: 'SET_SCAN_PROGRESS'; payload: number }
  | { type: 'SET_LOADING'; payload: boolean };

const initialState: LibraryState = {
  movies: [],
  tvShows: [],
  animeShows: [],
  libraryFolders: [],
  isScanning: false,
  scanProgress: 0,
  isLoading: true,
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
    case 'SET_SCANNING':
      return { ...state, isScanning: action.payload };
    case 'SET_SCAN_PROGRESS':
      return { ...state, scanProgress: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    default:
      return state;
  }
}

interface LibraryContextType {
  state: LibraryState;
  dispatch: React.Dispatch<LibraryAction>;
  scanLibrary: () => Promise<void>;
  addLibraryFolder: () => Promise<void>;
  removeLibraryFolder: (folder: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
}

const LibraryContext = createContext<LibraryContextType | undefined>(undefined);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(libraryReducer, initialState);

  const refreshLibrary = async () => {
    try {
      const data = await desktopApi.getLibrary();
      dispatch({ type: 'SET_MOVIES', payload: data.movies || [] });
      dispatch({ type: 'SET_TV_SHOWS', payload: data.tvShows || [] });
      dispatch({ type: 'SET_ANIME_SHOWS', payload: data.animeShows || [] });
      dispatch({ type: 'SET_LIBRARY_FOLDERS', payload: data.libraryFolders || [] });
    } catch (error) {
      console.error('Failed to load library:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const scanLibrary = async () => {
    dispatch({ type: 'SET_SCANNING', payload: true });
    dispatch({ type: 'SET_SCAN_PROGRESS', payload: 0 });
    try {
      await desktopApi.scanLibrary();
    } catch (error) {
      console.error('Failed to scan library:', error);
    } finally {
      dispatch({ type: 'SET_SCANNING', payload: false });
      await refreshLibrary();
    }
  };

  const addLibraryFolder = async () => {
    try {
      await desktopApi.addLibraryFolder();
      await refreshLibrary();
    } catch (error) {
      console.error('Failed to add library folder:', error);
    }
  };

  const removeLibraryFolder = async (folder: string) => {
    try {
      await desktopApi.removeLibraryFolder(folder);
      await refreshLibrary();
    } catch (error) {
      console.error('Failed to remove library folder:', error);
    }
  };

  useEffect(() => {
    refreshLibrary();
  }, []);

  return (
    <LibraryContext.Provider value={{ state, dispatch, scanLibrary, addLibraryFolder, removeLibraryFolder, refreshLibrary }}>
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
