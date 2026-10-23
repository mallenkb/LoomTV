import { useCallback, useEffect, useState } from 'react';
import { useProfiles } from '@/contexts/ProfileContext';
import type { StremioPluginCatalogItem } from '@/lib/desktopApi';
import { requireUsableSource } from '@/lib/addonPlayback';
import { getDesktopLibraryMode, getRemoteDesktopSession } from '@/lib/remoteDesktop';
import { queryScope } from '@/lib/queryClient';

export type AddonBookmark = {
  key: string;
  item: StremioPluginCatalogItem;
  addonId?: string;
  addonName?: string;
  streamAddonId?: string;
};
const EVENT = 'loomtv:addon-bookmarks-changed';
const PREFIX = 'addon-bookmark:';
const storageKey = (profileId: string) => `loomtv:addon-bookmarks:v1:${JSON.stringify([
  getDesktopLibraryMode() === 'remote' ? getRemoteDesktopSession()?.baseUrl : 'local', profileId,
])}`;

function identity(item: StremioPluginCatalogItem, addonId?: string): string {
  return JSON.stringify([addonId || item.source || 'discover', item.type, item.providerId || item.imdbId || item.id]);
}

function read(profileId: string): AddonBookmark[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(profileId)) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is AddonBookmark => value && typeof value.key === 'string'
      && value.key.startsWith(PREFIX) && value.item && typeof value.item.id === 'string'
      && typeof value.item.type === 'string' && typeof value.item.title === 'string'
      && Array.isArray(value.item.genres) && (value.addonId === undefined || typeof value.addonId === 'string')
      && (value.streamAddonId === undefined || typeof value.streamAddonId === 'string'));
  } catch { return []; }
}

// Keep title metadata and stable identities. Playback grants and streams are resolved afresh.
function snapshot(item: StremioPluginCatalogItem): StremioPluginCatalogItem {
  return {
    id: item.id, type: item.type, title: item.title, genres: item.genres,
    source: item.source, providerId: item.providerId, metaKey: item.metaKey,
    imdbId: item.imdbId, tmdbId: item.tmdbId, defaultVideoId: item.defaultVideoId,
    artwork: item.artwork, posterUrl: item.posterUrl, posterFallbackUrl: item.posterFallbackUrl,
    backgroundUrl: item.backgroundUrl, logoUrl: item.logoUrl, description: item.description,
    releaseInfo: item.releaseInfo, released: item.released, rating: item.rating,
    providerRatings: item.providerRatings, contentRating: item.contentRating,
    runtime: item.runtime, trailerUrl: item.trailerUrl, seasonCount: item.seasonCount,
  };
}

export function useAddonBookmarks() {
  const { activeProfile, lists, setListEntry } = useProfiles();
  const profileId = activeProfile?.id;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  // Read against the current profile rather than retaining the previous profile's titles in state.
  const records = profileId ? read(profileId) : [];
  const savedKeys = new Set(lists.filter(entry => entry.kind === 'watchlist' || entry.kind === 'favorite').map(entry => entry.mediaId));
  const bookmarks = records.filter(record => savedKeys.has(record.key));
  const isSaved = (item: StremioPluginCatalogItem, addonId?: string) => bookmarks.some(record => identity(record.item, record.addonId) === identity(item, addonId));

  const toggle = useCallback(async (item: StremioPluginCatalogItem, addonId?: string, streamAddonId?: string) => {
    if (!profileId) throw new Error('Choose a profile before saving a title.');
    const scope = JSON.stringify(queryScope());
    const current = read(profileId);
    const existing = current.find(record => identity(record.item, record.addonId) === identity(item, addonId));
    const saved = existing && lists.some(entry => entry.mediaId === existing.key && (entry.kind === 'watchlist' || entry.kind === 'favorite'));
    if (saved) {
      await setListEntry(existing.key, 'watchlist', false);
      if (lists.some(entry => entry.mediaId === existing.key && entry.kind === 'favorite')) await setListEntry(existing.key, 'favorite', false);
      return;
    }
    const source = addonId ? await requireUsableSource(addonId) : undefined;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity(item, addonId)));
    if (scope !== JSON.stringify(queryScope())) return;
    const key = PREFIX + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const record: AddonBookmark = { key, item: snapshot(item), addonId, addonName: source?.name, streamAddonId };
    localStorage.setItem(storageKey(profileId), JSON.stringify([record, ...read(profileId).filter(entry => entry.key !== key)]));
    window.dispatchEvent(new Event(EVENT));
    await setListEntry(key, 'watchlist', true);
  }, [profileId, lists, setListEntry]);
  // The event revision makes this hook update when another mounted view saves a snapshot.
  void revision;
  return { bookmarks, isSaved, toggle };
}
