export const DISCOVER_RETURN_ROUTE_CACHE_KEY = 'loomtv:discover-return-route-v1';
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
