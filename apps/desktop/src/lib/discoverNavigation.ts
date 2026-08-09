import type { StremioPluginCatalogItem } from '@/lib/desktopApi';

export const DISCOVER_RETURN_ROUTE_CACHE_KEY = 'loomtv:discover-return-route-v1';
const EXPLORE_ITEM_CACHE_PREFIX = 'loomtv:explore-item-v1:';
const DISCOVER_RETURN_ROUTE_TTL_MS = 7_200_000;

type CachedDiscoverReturnRoute = { at: number; route: string };

function normalizeDiscoverReturnRoute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const route = value.trim();
  return route.startsWith('/discover') ? route : null;
}

export function cacheDiscoverReturnRoute(route: string): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeDiscoverReturnRoute(route);
  if (!normalized) return;
  try {
    window.sessionStorage.setItem(DISCOVER_RETURN_ROUTE_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      route: normalized,
    } satisfies CachedDiscoverReturnRoute));
  } catch {
    // Session history is an enhancement; router state remains authoritative.
  }
}

export function getCachedDiscoverReturnRoute(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(DISCOVER_RETURN_ROUTE_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedDiscoverReturnRoute>;
    const route = normalizeDiscoverReturnRoute(cached.route);
    const cachedAt = cached.at;
    if (!route || typeof cachedAt !== 'number' || !Number.isSafeInteger(cachedAt)) return null;
    const age = Date.now() - cachedAt;
    if (age < 0 || age > DISCOVER_RETURN_ROUTE_TTL_MS) {
      window.sessionStorage.removeItem(DISCOVER_RETURN_ROUTE_CACHE_KEY);
      return null;
    }
    return route;
  } catch {
    return null;
  }
}

export function cacheExploreItem(item: StremioPluginCatalogItem): void {
  if (typeof window === 'undefined' || !item.id || !item.type) return;
  try {
    window.sessionStorage.setItem(`${EXPLORE_ITEM_CACHE_PREFIX}${item.type}:${item.id}`, JSON.stringify(item));
  } catch {
    // Route state remains authoritative when session storage is unavailable.
  }
}

export function getCachedExploreItem(type: string, id?: string): StremioPluginCatalogItem | null {
  if (typeof window === 'undefined' || !id) return null;
  try {
    const raw = window.sessionStorage.getItem(`${EXPLORE_ITEM_CACHE_PREFIX}${type}:${id}`);
    if (!raw) return null;
    const item = JSON.parse(raw) as StremioPluginCatalogItem;
    return item && item.id === id && item.type === type ? item : null;
  } catch {
    return null;
  }
}
