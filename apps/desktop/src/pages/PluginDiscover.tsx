import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Info, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import {
  desktopApi,
  type StremioPluginCatalogDefinition,
  type StremioPluginCatalogItem,
  type StremioPluginSummary,
} from '@/lib/desktopApi';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The provider request failed.';
}

function canRequestCatalog(catalog: StremioPluginCatalogDefinition): boolean {
  return catalog.extra.every((extra) => !extra.isRequired || Boolean(extra.options?.length));
}

function requiredCatalogExtra(catalog: StremioPluginCatalogDefinition): Record<string, string> {
  return Object.fromEntries(catalog.extra
    .filter((extra) => extra.isRequired && extra.options?.length)
    .map((extra) => [extra.name, String(extra.options?.[0] || '')]));
}

export default function PluginDiscover() {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const [plugins, setPlugins] = useState<StremioPluginSummary[]>([]);
  const [addonId, setAddonId] = useState('');
  const [catalogKey, setCatalogKey] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly StremioPluginCatalogItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<StremioPluginCatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const catalogRequestRevision = useRef(0);
  const metaRequestRevision = useRef(0);

  const catalogPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.catalogs.some(canRequestCatalog)),
    [plugins],
  );
  const plugin = useMemo(
    () => catalogPlugins.find((candidate) => candidate.addonId === addonId) || catalogPlugins[0] || null,
    [addonId, catalogPlugins],
  );
  const catalogs = useMemo(
    () => plugin?.catalogs.filter(canRequestCatalog) || [],
    [plugin],
  );
  const catalog = useMemo(
    () => catalogs.find((candidate) => `${candidate.type}:${candidate.id}` === catalogKey) || catalogs[0] || null,
    [catalogKey, catalogs],
  );
  const supportsSearch = Boolean(catalog?.extra.some(({ name }) => name === 'search'));
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const frameTopPaddingClass = isModern ? 'pt-28' : 'pt-8';
  const framePaddingClass = isModern ? 'px-[var(--loom-frame-inset)]' : '';

  useEffect(() => {
    let mounted = true;
    catalogRequestRevision.current += 1;
    metaRequestRevision.current += 1;
    setLoading(true);
    setError(null);
    void desktopApi.listAvailableStremioPlugins()
      .then((available) => {
        if (!mounted) return;
        setPlugins(available);
        setAddonId((current) => available.some(({ addonId: id }) => id === current) ? current : (available[0]?.addonId || ''));
      })
      .catch((loadError) => { if (mounted) setError(errorMessage(loadError)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [activeProfile?.id]);

  useEffect(() => {
    if (!plugin) return;
    setAddonId(plugin.addonId);
  }, [plugin]);

  useEffect(() => {
    if (!catalog) return;
    setCatalogKey(`${catalog.type}:${catalog.id}`);
  }, [catalog]);

  const loadCatalog = useCallback(async (search = '') => {
    if (!plugin || !catalog) return;
    const requestRevision = ++catalogRequestRevision.current;
    setLoading(true);
    setError(null);
    setSelectedItem(null);
    try {
      const extra: Record<string, string | number | boolean> = requiredCatalogExtra(catalog);
      if (search.trim() && supportsSearch) extra.search = search.trim();
      const result = await desktopApi.getStremioCatalog(plugin.addonId, {
        type: catalog.type,
        catalogId: catalog.id,
        ...(Object.keys(extra).length ? { extra } : {}),
      });
      if (requestRevision === catalogRequestRevision.current) setItems(result.items);
    } catch (catalogError) {
      if (requestRevision === catalogRequestRevision.current) {
        setItems([]);
        setError(errorMessage(catalogError));
      }
    } finally {
      if (requestRevision === catalogRequestRevision.current) setLoading(false);
    }
  }, [catalog, plugin, supportsSearch]);

  useEffect(() => {
    if (plugin && catalog) void loadCatalog();
  }, [loadCatalog]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || supportsSearch) return items;
    return items.filter((item) => [item.title, item.description, item.releaseInfo, ...item.genres]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)));
  }, [items, query, supportsSearch]);

  const inspectItem = async (item: StremioPluginCatalogItem) => {
    if (!plugin) return;
    const requestRevision = ++metaRequestRevision.current;
    setError(null);
    try {
      const result = await desktopApi.getStremioMeta(plugin.addonId, { type: item.type, id: item.id });
      if (requestRevision === metaRequestRevision.current) setSelectedItem(result.item || item);
    } catch (metaError) {
      if (requestRevision === metaRequestRevision.current) setError(errorMessage(metaError));
    }
  };

  return (
    <div className="loom-page h-full overflow-y-auto">
      <div className={`${frameClass} page-bottom-safe pb-24 ${frameTopPaddingClass} ${framePaddingClass}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--loom-accent)]/15 text-[var(--loom-accent)]">
                <Compass className="h-5 w-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold text-white">Discover</h1>
                <p className="mt-1 text-sm text-[var(--loom-muted)]">Browse approved remote Stremio catalogs separately from your local library.</p>
              </div>
            </div>
          </div>
          <span className="rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 py-1.5 text-xs text-[var(--loom-muted)]">
            Catalog & metadata preview
          </span>
        </div>

        <div className="mt-6 rounded-xl border border-blue-400/25 bg-blue-400/10 p-3 text-sm text-blue-100">
          <p className="flex items-start gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0" /> Remote playback and subtitle attachment are not enabled in this foundation release.</p>
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
        )}

        {!loading && catalogPlugins.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)] p-8 text-center">
            <Compass className="mx-auto h-8 w-8 text-[var(--loom-faint)]" />
            <h2 className="mt-4 text-lg font-semibold text-white">No approved catalogs</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--loom-muted)]">
              An Owner can install and approve Cinemeta from Settings → Plugins. Kids and Guest profiles cannot use remote add-ons.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-3 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)] p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(240px,1.4fr)]">
              <label className="text-xs font-medium text-[var(--loom-faint)]">
                Provider
                <select
                  value={plugin?.addonId || ''}
                  onChange={(event) => { setAddonId(event.target.value); setCatalogKey(''); setQuery(''); }}
                  className="mt-1 h-10 w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-white"
                >
                  {catalogPlugins.map((candidate) => <option key={candidate.addonId} value={candidate.addonId}>{candidate.name}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-[var(--loom-faint)]">
                Catalog
                <select
                  value={catalog ? `${catalog.type}:${catalog.id}` : ''}
                  onChange={(event) => { setCatalogKey(event.target.value); setQuery(''); }}
                  className="mt-1 h-10 w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-white"
                >
                  {catalogs.map((candidate) => (
                    <option key={`${candidate.type}:${candidate.id}`} value={`${candidate.type}:${candidate.id}`}>{candidate.name} · {candidate.type}</option>
                  ))}
                </select>
              </label>
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => { event.preventDefault(); if (supportsSearch) void loadCatalog(query); }}
              >
                <label className="min-w-0 flex-1 text-xs font-medium text-[var(--loom-faint)]">
                  {supportsSearch ? 'Provider search' : 'Filter loaded titles'}
                  <span className="mt-1 flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3">
                    <Search className="h-4 w-4" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search titles"
                      className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-[var(--loom-faint)]"
                    />
                  </span>
                </label>
                {supportsSearch && <Button type="submit" size="sm" className="h-10" disabled={loading}>Search</Button>}
              </form>
            </div>

            {loading ? (
              <p className="py-16 text-center text-sm text-[var(--loom-muted)]">Loading provider catalog…</p>
            ) : visibleItems.length === 0 ? (
              <p className="py-16 text-center text-sm text-[var(--loom-muted)]">No titles returned for this catalog.</p>
            ) : (
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleItems.map((item) => (
                  <button
                    key={`${item.type}:${item.id}`}
                    type="button"
                    onClick={() => void inspectItem(item)}
                    className="min-h-44 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-panel)] p-4 text-left transition-colors hover:border-[var(--loom-accent)]/50 hover:bg-[var(--loom-surface-2)]"
                  >
                    <p className="text-xs uppercase tracking-wide text-[var(--loom-accent)]">{item.type}</p>
                    <h2 className="mt-2 line-clamp-2 text-base font-semibold text-white">{item.title}</h2>
                    <p className="mt-2 text-xs text-[var(--loom-faint)]">{item.releaseInfo || item.released || 'Release date unavailable'}</p>
                    {item.genres.length > 0 && <p className="mt-3 line-clamp-2 text-xs leading-5 text-[var(--loom-muted)]">{item.genres.join(' · ')}</p>}
                    {item.rating !== undefined && <p className="mt-3 text-xs font-medium text-yellow-200">Rating {item.rating}</p>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {selectedItem && (
          <section className="mt-6 rounded-2xl border border-[var(--loom-accent)]/35 bg-[var(--loom-panel)] p-5" aria-live="polite">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-[var(--loom-accent)]">Metadata preview</p>
                <h2 className="mt-2 text-xl font-semibold text-white">{selectedItem.title}</h2>
                <p className="mt-1 text-sm text-[var(--loom-faint)]">{selectedItem.releaseInfo || selectedItem.released || selectedItem.type}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedItem(null)}>Close</Button>
            </div>
            {selectedItem.description && <p className="mt-4 max-w-3xl text-sm leading-6 text-[var(--loom-muted)]">{selectedItem.description}</p>}
            {selectedItem.genres.length > 0 && <p className="mt-4 text-xs text-[var(--loom-faint)]">{selectedItem.genres.join(' · ')}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
