import { createContext, useContext } from 'react';

// Search is a stateful overlay on Home, so it intentionally shares the exact
// `/` route instead of adding a pathname that the hash router does not expose.
const LIBRARY_FILTER_PATHNAMES: ReadonlySet<string> = new Set([
  '/',
  '/anime',
  '/tv',
  '/movies',
]);

export const LibraryFilterVisibilityContext = createContext(false);

export function isLibraryFilterPath(pathname: string): boolean {
  return LIBRARY_FILTER_PATHNAMES.has(pathname);
}

export function useLibraryFilterVisibility(): boolean {
  return useContext(LibraryFilterVisibilityContext);
}
