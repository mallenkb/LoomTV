import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clapperboard } from 'lucide-react';
import { useModalLayer } from '@/components/ui/dialog';
import { WATCH_PROVIDERS_PANEL_ID, WATCH_PROVIDERS_TRIGGER_ID } from '@/components/DetailWhereToWatch';
import { preferredProviderLogoUrl } from '@/shared/providerLogos';
import { requireUsableSource } from '@/lib/addonPlayback';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import { queryScope } from '@/lib/queryClient';
import { getCachedExploreItem } from '@/lib/discoverNavigation';
import { defaultWatchRegion, loadWatchProviders, providerNameKey, watchProviderLogo, watchRegionName, type WatchProviderLogo, type WatchProviderRegions } from '@/lib/watchProviders';
import type { StremioStreamDescriptor, StremioStreamResult } from '@/shared/desktopProtocol';

const WATCHHUB_ID = 'org.stremio.watchhub';

async function resolveCachedItem(item: StremioPluginCatalogItem): Promise<StremioPluginCatalogItem> {
  const cached = getCachedExploreItem(item.type === 'series' ? 'tv' : item.type, item.id);
  return cached ? { ...item, ...cached } : item;
}

function providerUrl(stream: StremioStreamDescriptor): string | undefined {
  if (stream.transport !== 'external' || !stream.externalUrl) return undefined;
  try {
    const url = new URL(stream.externalUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Ignore malformed provider links. */ }
  return undefined;
}

async function openExternal(url: string): Promise<void> {
  if (window.desktopApi?.openExternal) {
    await window.desktopApi.openExternal(url);
    return;
  }
  desktopApi.openExternal(url);
}

export default function WatchHubDialog({ item, resolveItem = resolveCachedItem, anchorElement, onClose }: {
  item: StremioPluginCatalogItem;
  resolveItem?: (item: StremioPluginCatalogItem) => Promise<StremioPluginCatalogItem>;
  anchorElement?: HTMLElement | null;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number }>({ top: 0, left: 0, width: 248, maxHeight: 480 });
  useModalLayer({ contentRef: layerRef, initialFocusRef: panelRef, onEscape: onClose });

  useLayoutEffect(() => {
    const position = () => {
      const rect = (anchorElement || document.getElementById(WATCH_PROVIDERS_TRIGGER_ID))?.getBoundingClientRect();
      const width = Math.min(248, Math.max(0, window.innerWidth - 24));
      const below = Math.max(0, window.innerHeight - (rect?.bottom ?? 56) - 20);
      const above = Math.max(0, (rect?.top ?? 0) - 20);
      const upwards = below < 220 && above > below;
      const maxHeight = Math.min(480, upwards ? above : below);
      setBounds({ width, maxHeight,
        left: Math.max(12, Math.min((rect?.right ?? window.innerWidth - 12) - width, window.innerWidth - width - 12)),
        top: upwards ? undefined : (rect?.bottom ?? 56) + 8,
        bottom: upwards ? window.innerHeight - (rect?.top ?? 0) + 8 : undefined,
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [anchorElement]);

  const [result, setResult] = useState<StremioStreamResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [regions, setRegions] = useState<WatchProviderRegions>({});
  const [logos, setLogos] = useState<WatchProviderLogo[]>([]);
  const [region, setRegion] = useState(defaultWatchRegion);
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const [scope] = useState(() => JSON.stringify(queryScope()));

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    const current = () => !controller.signal.aborted && scope === JSON.stringify(queryScope());
    void (async () => {
      try {
        const resolved = await resolveItem(item);
        if (!current()) return;
        const [watchHub, metadata] = await Promise.allSettled([
          (async () => {
            await requireUsableSource(WATCHHUB_ID);
            const imdbId = [resolved.imdbId, resolved.providerId, resolved.id].find(id => id && /^tt\d{5,12}$/.test(id));
            if (!imdbId) throw new Error('No IMDb identity is available.');
            return desktopApi.getStremioStreams(WATCHHUB_ID, {
              type: resolved.type === 'movie' ? 'movie' : 'series', id: imdbId,
            }, controller.signal);
          })(),
          loadWatchProviders(resolved),
        ]);
        if (!current()) return;
        setResult(watchHub.status === 'fulfilled' ? watchHub.value : null);
        if (metadata.status === 'fulfilled') {
          setRegions(metadata.value.regions);
          setLogos(metadata.value.logos);
        }
        const metadataError = metadata.status === 'rejected' || Boolean(metadata.value.error);
        setError(metadataError ? (watchHub.status === 'fulfilled'
          ? 'Additional providers could not be loaded.' : 'Providers could not be loaded. Try again.') : '');
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : 'WatchHub could not load providers. Try again.');
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [item, resolveItem, attempt, scope]);

  async function openProvider(stream: StremioStreamDescriptor) {
    const url = providerUrl(stream);
    if (!url || opening) return;
    const controller = requestRef.current;
    setOpening(true);
    setError('');
    try {
      await requireUsableSource(WATCHHUB_ID, result?.sourceRevision);
      if (!controller || controller.signal.aborted || scope !== JSON.stringify(queryScope())) return;
      await openExternal(url);
    } catch (cause) {
      if (!controller?.signal.aborted) setError(cause instanceof Error ? cause.message : 'The provider website could not be opened.');
    } finally {
      if (!controller?.signal.aborted) setOpening(false);
    }
  }

  const watchHubProviders = result?.streams.flatMap(stream => {
    const url = providerUrl(stream);
    return url ? [{ stream, url, name: stream.name || new URL(url).hostname }] : [];
  }) ?? [];
  const localOffers = regions[region];
  const hasRegionalData = Object.keys(regions).length > 0;
  const countryCodes = [...new Set([region, ...Object.keys(regions)])]
    .sort((left, right) => watchRegionName(left).localeCompare(watchRegionName(right)));
  type ProviderRow = { key: string; name: string; logoUrl: string; labels: Set<string>; url?: string; stream?: StremioStreamDescriptor };
  const grouped = new Map<number, ProviderRow>();
  for (const [group, label] of [['flatrate', 'Stream'], ['free', 'Stream'], ['ads', 'Stream'], ['buy', 'Buy'], ['rent', 'Rent']] as const) {
    for (const provider of localOffers?.[group] || []) {
      let row = grouped.get(provider.provider_id);
      if (!row) {
        const direct = watchHubProviders.find(candidate => providerNameKey(candidate.name) === providerNameKey(provider.provider_name));
        row = { key: String(provider.provider_id), name: provider.provider_name,
          logoUrl: preferredProviderLogoUrl({ name: provider.provider_name, logoPath: provider.logo_path }) || watchProviderLogo(provider.provider_name, logos),
          labels: new Set(), url: direct?.url || tmdbWatchUrl(localOffers?.link), stream: direct?.stream };
        grouped.set(provider.provider_id, row);
      }
      row.labels.add(label);
    }
  }
  const providers: ProviderRow[] = hasRegionalData ? [...grouped.values()] : watchHubProviders.map(({ stream, name, url }) => {
    const known = item.streamingProviders?.find(candidate => providerNameKey(candidate.name) === providerNameKey(name));
    const description = stream.description || '';
    const labels = new Set(['Stream', 'Buy', 'Rent'].filter(label => (
      label === 'Stream' ? /stream|subscription|free|ads/i.test(description) : new RegExp(label, 'i').test(description)
    )));
    return { key: stream.id, name, url, stream, labels,
      logoUrl: watchProviderLogo(name, logos) || (known ? preferredProviderLogoUrl(known) : '') };
  });

  async function openRow(row: ProviderRow) {
    if (row.stream) { await openProvider(row.stream); return; }
    const controller = requestRef.current;
    if (!row.url || opening || !controller || controller.signal.aborted || scope !== JSON.stringify(queryScope())) return;
    setOpening(true);
    try { await openExternal(row.url); }
    catch { if (!controller.signal.aborted) setError('The provider website could not be opened.'); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }

  return createPortal(
    <div ref={layerRef} className="loom-no-drag fixed inset-0 z-[10000]" onPointerDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={panelRef} id={WATCH_PROVIDERS_PANEL_ID} role="dialog" aria-modal="true" aria-label="Where to watch"
        tabIndex={-1} style={bounds}
        className="fixed overflow-y-auto overscroll-contain rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-1.5 text-[var(--loom-text)] shadow-2xl">
        {loading ? <p role="status" className="px-2.5 py-3 text-sm text-[var(--loom-muted)]">Finding providers…</p> : null}
        {!loading && !error && providers.length === 0 ? <p className="px-2.5 py-3 text-sm text-[var(--loom-muted)]">No providers found{hasRegionalData ? ` in ${watchRegionName(region)}` : ' for this title'}.</p> : null}
        <div>
          {providers.map(row => <button key={row.key} type="button" disabled={opening || !row.url}
            title={row.stream ? 'Open provider website' : 'View watch options on TMDB'}
            onClick={() => { void openRow(row); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--loom-surface-3)] focus-visible:bg-[var(--loom-surface-3)] disabled:opacity-50">
            <ProviderLogo key={`${row.name}:${row.logoUrl}`} url={row.logoUrl} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={row.name}>{row.name}</span>
              {row.labels.size > 0 ? <span className="block text-xs text-[var(--loom-muted)]">{['Stream', 'Buy', 'Rent'].filter(label => row.labels.has(label)).join(' · ')}</span> : null}
            </span>
          </button>)}
        </div>
        {error ? <div role="alert" className="px-2.5 py-2 text-xs text-[var(--loom-muted)]">
          {error} <button type="button" disabled={opening || loading} onClick={() => {
            setLoading(true); setError(''); setAttempt(value => value + 1);
          }} className="underline underline-offset-2 disabled:opacity-50">Retry</button>
        </div> : null}
        {!loading && hasRegionalData ? <div className="flex items-center justify-between gap-2 border-t border-[var(--loom-border)] px-2 pt-1.5 pb-0.5 text-[11px] text-[var(--loom-muted)]">
          <span className="min-w-0 truncate" title="JustWatch via TMDB">JustWatch via TMDB</span>
          <select aria-label="Provider country" value={region} onChange={event => setRegion(event.target.value)}
            className="min-w-0 max-w-[50%] cursor-pointer rounded-md border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-1.5 py-1 text-xs text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]">
            {countryCodes.map(code => <option key={code} value={code}>{watchRegionName(code)}</option>)}
          </select>
        </div> : null}
      </div>
    </div>, document.body,
  );
}

function tmdbWatchUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.hostname === 'www.themoviedb.org' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function ProviderLogo({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--loom-surface-3)]">
    {url && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setFailed(true)} /> : <Clapperboard className="h-4 w-4 text-[var(--loom-muted)]" />}
  </span>;
}
