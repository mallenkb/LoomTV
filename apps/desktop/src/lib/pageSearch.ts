import { useEffect } from 'react';

export const PAGE_SEARCH_EVENT = 'loom:open-page-search';
export type PageSearchFilter = 'all' | 'movie' | 'tv' | 'anime';

export function pageSearchFilter(pathname: string): PageSearchFilter {
  if (/^\/anime(?:\/|$)/.test(pathname)) return 'anime';
  if (/^\/tv(?:\/|$)/.test(pathname)) return 'tv';
  if (/^\/movies?(?:\/|$)/.test(pathname)) return 'movie';
  return 'all';
}

/** Let the visible page handle search without navigating away from it. */
export function openPageSearch() {
  window.dispatchEvent(new Event(PAGE_SEARCH_EVENT, { cancelable: true }));
}

export function usePageSearch(onOpen: () => void) {
  useEffect(() => {
    const handle = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener(PAGE_SEARCH_EVENT, handle);
    return () => window.removeEventListener(PAGE_SEARCH_EVENT, handle);
  }, [onOpen]);
}
