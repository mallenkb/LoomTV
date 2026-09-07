import { forwardRef, useCallback, type AnchorHTMLAttributes } from 'react';
import { Link as RouterLink, useLocation as useRouterLocation, useRouter } from '@tanstack/react-router';

export function parseDesktopSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}
export function stringifyDesktopSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}

// App links may originate in addon metadata or saved return locations. Parse
// their query strings once at this boundary; TanStack owns all navigation.
export function destination(to: string) {
  const url = new URL(to, 'https://loomtv.local');
  const location = { search: Object.fromEntries(url.searchParams), hash: url.hash.slice(1) };
  const media = /^\/(movie|tv|anime)\/([^/]+)$/.exec(url.pathname);
  if (media) {
    const params = { id: decodeURIComponent(media[2]) };
    if (media[1] === 'movie') return { ...location, to: '/movie/$id' as const, params };
    if (media[1] === 'anime') return { ...location, to: '/anime/$id' as const, params };
    return { ...location, to: '/tv/$id' as const, params };
  }
  const live = /^\/live\/([^/]+)$/.exec(url.pathname);
  if (live) return { ...location, to: '/live/$sourceId' as const, params: { sourceId: decodeURIComponent(live[1]) } };
  const addon = /^\/addons\/stremio\/([^/]+)$/.exec(url.pathname);
  if (addon) return { ...location, to: '/addons/stremio/$addonId' as const, params: { addonId: decodeURIComponent(addon[1]) } };
  const paths = ['/', '/movies', '/tv', '/anime', '/others', '/discover', '/my-list', '/settings'] as const;
  const path = paths.find(path => path === url.pathname) || '/';
  return { ...location, to: path, params: {} };
}

export function useLocation() {
  return useRouterLocation({ select: location => ({
    pathname: location.pathname, search: location.searchStr, hash: location.hash ? `#${location.hash}` : '',
    state: location.state as unknown, key: location.state.__TSR_key,
  }) });
}

export function useNavigate() {
  const router = useRouter();
  return useCallback((to: string | number | { pathname: string; search?: string }, options?: { replace?: boolean; state?: unknown }) => {
    if (typeof to === 'number') { router.history.go(to); return; }
    return router.navigate({ ...destination(typeof to === 'string' ? to : `${to.pathname}${to.search || ''}`), replace: options?.replace, state: options?.state as never });
  }, [router]);
}

export const Link = forwardRef<HTMLAnchorElement, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string; state?: unknown; replace?: boolean;
}>(function Link({ to, state, replace, ...props }, ref) {
  return <RouterLink {...props} {...destination(to)} state={state as never} replace={replace} preload="intent" ref={ref} />;
});
