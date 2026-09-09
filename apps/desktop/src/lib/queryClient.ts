import { isCancelledError, QueryClient } from '@tanstack/react-query';
import { getDesktopLibraryMode, getRemoteDesktopSession } from './remoteDesktop';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 180_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      networkMode: 'always',
    },
    mutations: { retry: false, gcTime: 0, networkMode: 'always' },
  },
});

let profileId: string | null = null;
let generation = 0;
let lastIdentity = '';
export function setQueryProfile(next: string | null): void {
  if (next === profileId) return;
  profileId = next;
  generation += 1;
  queryClient.clear();
}

export function queryScope(): readonly unknown[] {
  const session = getDesktopLibraryMode() === 'remote' ? getRemoteDesktopSession() : null;
  const scope = [session?.baseUrl || 'local', session?.deviceId || '', session?.selectionRevision || 0, profileId, generation];
  const identity = JSON.stringify(scope);
  if (lastIdentity && identity !== lastIdentity) queryClient.clear();
  lastIdentity = identity;
  return scope;
}

// This bounds metadata entries, not decoded WebKit images. Active queries are
// retained; inactive results have both a TTL and a count limit.
let trimming = false;
const sizes = new Map<string, number>();
function approximateBytes(value: unknown, seen = new WeakSet<object>(), budget = 8 * 1024 * 1024): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 32;
  for (const key of Object.keys(value)) {
    bytes += key.length * 2 + approximateBytes(Reflect.get(value, key), seen, budget - bytes);
    if (bytes > budget) break;
  }
  return bytes;
}
export function trimQueryCache(): void {
  if (trimming) return;
  trimming = true;
  try {
    const cache = queryClient.getQueryCache();
    const idle = cache.getAll()
      .filter(query => query.getObserversCount() === 0 && query.state.fetchStatus === 'idle')
      .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
    const counts = new Map<string, number>();
    for (const query of [...idle].reverse()) {
      const family = String(query.queryKey[0]);
      const limit = family === 'discover' ? 12 : family === 'detail' || family === 'explore' || family === 'discover-detail' ? 24 : 96;
      const count = (counts.get(family) || 0) + 1;
      counts.set(family, count);
      // We already have the query. Avoid scanning and matching the whole cache
      // again for each eviction in a burst of completed native reads.
      if (count > limit) cache.remove(query);
    }
    const remaining = cache.getAll().length;
    let excess = Math.max(0, remaining - 160);
    for (const query of idle) {
      if (excess <= 0) break;
      if (cache.get(query.queryHash) !== query) continue;
      cache.remove(query);
      excess -= 1;
    }
    // Only charge entries eligible for eviction. An active large result must
    // not force every unrelated inactive result out of the cache.
    let bytes = idle.reduce((sum, query) => sum + (
      cache.get(query.queryHash) === query ? sizes.get(query.queryHash) || 0 : 0
    ), 0);
    for (const query of idle) {
      if (bytes <= 8 * 1024 * 1024) break;
      if (cache.get(query.queryHash) !== query) continue;
      bytes -= sizes.get(query.queryHash) || 0;
      cache.remove(query);
    }
  } finally { trimming = false; }
}
queryClient.getQueryCache().subscribe(event => {
  if (event.type === 'removed') sizes.delete(event.query.queryHash);
  if (event.type === 'updated' && event.action.type === 'success') {
    sizes.set(event.query.queryHash, approximateBytes(event.query.state.data));
    trimQueryCache();
  }
});

let activeReads = 0;
const pendingReads: (() => void)[] = [];
async function scheduledRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener('abort', abort);
      activeReads += 1;
      resolve();
    };
    const abort = () => {
      const index = pendingReads.indexOf(start);
      if (index !== -1) pendingReads.splice(index, 1);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    if (signal.aborted) { abort(); return; }
    if (activeReads < 4) start();
    else { pendingReads.push(start); signal.addEventListener('abort', abort, { once: true }); }
  });
  try {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    return await read();
  } finally { activeReads -= 1; pendingReads.shift()?.(); }
}

export async function cachedDesktopRead<T>(family: string, args: readonly unknown[], read: () => Promise<T>, staleTime = 60_000): Promise<T> {
  const expensive = family === 'getThumbnail' || family === 'requestMetadataProvider' || family === 'getMediaSegments';
  const recoverCancellation = family === 'requestMetadataProvider' || family.startsWith('discover-');
  const scope = queryScope();
  const identity = JSON.stringify(scope);
  const options = {
    queryKey: [family, ...scope, ...args],
    queryFn: ({ signal }: { signal: AbortSignal }) => expensive ? scheduledRead(read, signal) : read(),
    staleTime,
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await queryClient.fetchQuery(options);
    } catch (error) {
      // Imperative reads have no observers. Invalidating them during a write
      // cancels their promises even while a page is waiting for the result.
      // Restart against the updated cache, but never cross a profile/session.
      if (!recoverCancellation || !isCancelledError(error) || attempt >= 2 || JSON.stringify(queryScope()) !== identity) throw error;
    }
  }
}

export function invalidateDesktopData(families?: readonly string[]): void {
  // Removing imperative fetchQuery entries also prevents a response started
  // before a write from becoming the cached result after that write.
  const predicate = (query: { queryKey: readonly unknown[] }) => !families || families.includes(String(query.queryKey[0]));
  queryClient.removeQueries({ type: 'inactive', predicate });
  void queryClient.invalidateQueries({ type: 'active', predicate });
}
