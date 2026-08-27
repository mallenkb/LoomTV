import { useEffect, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import type { IptvSourceSummary } from '@/shared/desktopProtocol';

/**
 * Adding a live TV source adds a sidebar tab, so the sidebar and the settings
 * screen have to agree on the list without one owning the other. They share it
 * through the same window-event channel the sidebar already uses for folder
 * names and nav order.
 */
export const IPTV_SOURCES_CHANGED_EVENT = 'loomtv:iptv-sources-changed';

export function notifyIptvSourcesChanged(sources?: readonly IptvSourceSummary[]): void {
  window.dispatchEvent(new CustomEvent<readonly IptvSourceSummary[] | undefined>(
    IPTV_SOURCES_CHANGED_EVENT,
    { detail: sources },
  ));
}

export function liveTvRoute(sourceId: string): string {
  return `/live/${encodeURIComponent(sourceId)}`;
}

/** Keep auto-derived playlist filenames out of the product-facing label. */
export function iptvSourceDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim() || '';
  const genericName = trimmed.toLowerCase().replace(/\.(?:m3u8?|txt)$/i, '');
  return !trimmed || genericName === 'index' ? 'IPTV' : trimmed;
}

/** Subscribe to the current live TV sources, refetching when they change. */
export function useIptvSources(): { sources: IptvSourceSummary[]; isLoading: boolean } {
  const [sources, setSources] = useState<IptvSourceSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      desktopApi.listIptvSources()
        .then((next) => {
          if (mounted) setSources(next);
        })
        .catch(() => {
          if (mounted) setSources([]);
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });
    };
    load();

    const handleChanged = (event: Event) => {
      const detail = (event as CustomEvent<readonly IptvSourceSummary[] | undefined>).detail;
      // A mutation that already has the new list passes it along; anything
      // else (a refresh elsewhere in the app) asks for a fresh read.
      if (detail) setSources([...detail]);
      else load();
    };
    window.addEventListener(IPTV_SOURCES_CHANGED_EVENT, handleChanged);
    return () => {
      mounted = false;
      window.removeEventListener(IPTV_SOURCES_CHANGED_EVENT, handleChanged);
    };
  }, []);

  return { sources, isLoading };
}
