import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Play, RefreshCw } from 'lucide-react';
import { useParams } from 'react-router';
import { z } from 'zod';
import SafeArtwork from '@/components/SafeArtwork';
import LibrarySearch from '@/components/LibrarySearch';
import { PosterGridShimmer } from '@/components/ContentShimmer';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi, type StremioPluginSummary } from '@/lib/desktopApi';

const ARCHIVE_ADDON_ID = 'org.archive.clean';
const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;
const ARCHIVE_SEARCH_BASE = 'mediatype:movies AND collection:feature_films AND NOT subject:(adult OR nudity OR sex OR porn OR pornography OR exploitation)';

const archiveDocumentSchema = z.object({
  identifier: z.string().min(1),
  title: z.union([z.string(), z.array(z.string())]).optional(),
  description: z.union([z.string(), z.array(z.string())]).optional(),
  year: z.union([z.number(), z.string()]).optional(),
  date: z.string().optional(),
  downloads: z.union([z.number(), z.string()]).optional(),
  subject: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

const archiveSearchSchema = z.object({
  response: z.object({
    numFound: z.number().nonnegative(),
    docs: z.array(archiveDocumentSchema),
  }),
});

const archiveFileSchema = z.object({
  name: z.string(),
  format: z.string().optional(),
  source: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const archiveMetadataSchema = z.object({
  files: z.array(archiveFileSchema).default([]),
});

type ArchiveDocument = z.output<typeof archiveDocumentSchema>;

type ArchiveOrgAddonProps = {
  onPlay: (streamUrl: string, title: string, posterUrl: string) => void;
};

function firstText(value: string | readonly string[] | undefined): string {
  if (Array.isArray(value)) return value.find((entry) => entry.trim())?.trim() || '';
  return typeof value === 'string' ? value.trim() : '';
}

function safeYear(item: ArchiveDocument): string {
  const raw = item.year ?? item.date?.slice(0, 4) ?? '';
  const value = String(raw).trim();
  return /^(18|19|20)\d{2}$/.test(value) ? value : '';
}

function itemTitle(item: ArchiveDocument): string {
  return firstText(item.title) || item.identifier.replaceAll(/[_-]+/g, ' ');
}

function posterUrl(identifier: string): string {
  return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
}

function archiveSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return ARCHIVE_SEARCH_BASE;
  const escaped = trimmed.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `${ARCHIVE_SEARCH_BASE} AND title:"${escaped}"`;
}

function archiveSearchUrl(query: string, page: number): string {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', archiveSearchQuery(query));
  ['identifier', 'title', 'description', 'year', 'date', 'downloads', 'subject'].forEach((field) => {
    url.searchParams.append('fl[]', field);
  });
  url.searchParams.append('sort[]', query.trim() ? 'downloads desc' : 'downloads desc');
  url.searchParams.set('rows', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('output', 'json');
  return url.toString();
}

function findImdbId(item: ArchiveDocument): string {
  const haystack = `${firstText(item.description)} ${item.identifier}`;
  return haystack.match(/\btt\d{7,9}\b/i)?.[0]?.toLowerCase() || '';
}

function fileSize(file: z.output<typeof archiveFileSchema>): number {
  const value = Number(file.size || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function playableArchiveFile(files: readonly z.output<typeof archiveFileSchema>[]): string {
  const candidates = files.filter((file) => {
    const name = file.name.trim();
    const format = file.format?.toLowerCase() || '';
    return /\.mp4$/i.test(name)
      && !/(sample|trailer|thumb|preview)/i.test(name)
      && (!format || /(mpeg4|h\.264|512kb)/i.test(format));
  });
  candidates.sort((left, right) => {
    const sourceDifference = Number(right.source === 'original') - Number(left.source === 'original');
    return sourceDifference || fileSize(right) - fileSize(left);
  });
  return candidates[0]?.name || '';
}

function downloadUrl(identifier: string, fileName: string): string {
  const encodedFile = fileName.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedFile}`;
}

function compactDownloads(value: ArchiveDocument['downloads']): string {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return '';
  return `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(count)} plays`;
}

async function requireEnabledArchivePlugin(addonId: string): Promise<StremioPluginSummary> {
  if (addonId !== ARCHIVE_ADDON_ID) throw new Error('That Archive.org add-on is not supported.');
  const plugins = await desktopApi.listAvailableStremioPlugins();
  const installed = plugins.find((plugin) => (
    plugin.addonId === addonId
    && plugin.state === 'enabled'
    && plugin.trusted
  ));
  if (!installed) throw new Error('The Archive.org add-on is not installed and enabled.');
  return installed;
}

export default function ArchiveOrgAddon({ onPlay }: ArchiveOrgAddonProps) {
  const { addonId = '' } = useParams();
  const { theme } = useTheme();
  const [addon, setAddon] = useState<StremioPluginSummary | null>(null);
  const [items, setItems] = useState<ArchiveDocument[]>([]);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const [playingId, setPlayingId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const installed = await requireEnabledArchivePlugin(addonId);
      const response = await fetch(archiveSearchUrl(query, page), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Archive.org returned ${response.status}.`);
      const payload = archiveSearchSchema.parse(await response.json());
      setAddon(installed);
      setItems(payload.response.docs);
      setTotal(payload.response.numFound);
    } catch (loadError) {
      setItems([]);
      setTotal(0);
      setError(loadError instanceof Error ? loadError.message : 'Archive.org could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [addonId, page, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(queryInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const maxPage = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const isModern = theme.homeStyle === 'modern';
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-6' : 'loom-discover-page-frame';

  const play = useCallback(async (item: ArchiveDocument) => {
    setPlayingId(item.identifier);
    setError('');
    try {
      await requireEnabledArchivePlugin(addonId);
      const imdbId = findImdbId(item);
      if (imdbId) {
        const providerResult = await desktopApi.getStremioStreams(addonId, { type: 'movie', id: imdbId });
        const providerStream = providerResult.streams.find((stream) => stream.url.startsWith('https://'));
        if (providerStream) {
          onPlay(providerStream.url, itemTitle(item), posterUrl(item.identifier));
          return;
        }
      }

      const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(item.identifier)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Archive.org returned ${response.status}.`);
      const metadata = archiveMetadataSchema.parse(await response.json());
      const fileName = playableArchiveFile(metadata.files);
      if (!fileName) throw new Error('Archive.org did not publish a direct MP4 for this item.');
      onPlay(downloadUrl(item.identifier, fileName), itemTitle(item), posterUrl(item.identifier));
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : 'That Archive.org movie could not be played.');
    } finally {
      setPlayingId('');
    }
  }, [addonId, onPlay]);

  return (
    <div
      className="loom-page loom-library-page h-full overflow-y-auto bg-[var(--loom-bg)]"
      onScroll={(event) => setIsHeaderScrolled(event.currentTarget.scrollTop > 4)}
    >
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass}`}>
        <header className={`loom-library-page-heading sticky top-0 z-40 isolate mb-6 flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-4 border-b bg-[var(--loom-bg)] py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ${isHeaderScrolled ? 'border-[var(--loom-border)] shadow-[0_12px_24px_-22px_rgb(0_0_0_/_0.9)]' : 'border-transparent'}`}>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">Archive.org</h1>
              <p className="mt-1 truncate text-sm text-[var(--loom-muted)]">
                {loading && total === 0
                  ? 'Loading public-domain movies'
                  : `${total.toLocaleString()} public-domain items · ${addon?.description || addon?.name || 'Archive.org'}`}
              </p>
            </div>
            <LibrarySearch value={queryInput} onChange={setQueryInput} placeholder="Search public-domain movies" placement="inline" />
          </div>
        </header>

        {error ? <div role="alert" className="mb-6 rounded-xl border border-red-800/70 bg-red-950/45 px-4 py-3 text-sm text-red-100">{error}</div> : null}

        {loading ? (
          <PosterGridShimmer count={15} className="grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-5 gap-y-8" />
        ) : items.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-[var(--loom-panel-border)] text-[var(--loom-muted)]">
            No Archive.org movies matched that search.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-5 gap-y-8" aria-label="Archive.org movies">
            {items.map((item) => {
              const title = itemTitle(item);
              const year = safeYear(item);
              const downloads = compactDownloads(item.downloads);
              const isPlaying = playingId === item.identifier;
              return (
                <article key={item.identifier} className="group min-w-0">
                  <button
                    type="button"
                    onClick={() => void play(item)}
                    disabled={Boolean(playingId)}
                    aria-label={`Play ${title}`}
                    className="relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-[var(--loom-surface-2)] text-left shadow-lg outline-none ring-[var(--loom-accent)] transition hover:-translate-y-1 focus-visible:ring-2 disabled:cursor-wait"
                  >
                    <SafeArtwork
                      src={posterUrl(item.identifier)}
                      alt={title}
                      className="h-full w-full"
                      imgClassName="object-cover transition-transform duration-300 group-hover:scale-105"
                      fallback={<div className="grid h-full place-items-center p-4 text-center text-sm text-[var(--loom-muted)]">{title}</div>}
                    />
                    <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
                    <span className="absolute inset-0 grid place-items-center bg-black/15 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <span className="grid h-14 w-14 place-items-center rounded-full bg-white text-black shadow-xl">
                        {isPlaying ? <RefreshCw className="h-6 w-6 animate-spin" /> : <Play className="ml-1 h-6 w-6 fill-current" />}
                      </span>
                    </span>
                  </button>
                  <h2 className="mt-3 line-clamp-2 text-base font-semibold text-[var(--loom-text)]">{title}</h2>
                  <p className="mt-1 text-sm text-[var(--loom-muted)]">{[year, downloads].filter(Boolean).join(' · ')}</p>
                </article>
              );
            })}
          </div>
        )}

        {!loading && total > PAGE_SIZE ? (
          <nav className="mt-10 flex items-center justify-center gap-4" aria-label="Archive.org pages">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="grid h-10 w-10 place-items-center rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)] disabled:opacity-35"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-sm text-[var(--loom-muted)]">Page {page.toLocaleString()} of {maxPage.toLocaleString()}</span>
            <button
              type="button"
              disabled={page >= maxPage}
              onClick={() => setPage((current) => Math.min(maxPage, current + 1))}
              className="grid h-10 w-10 place-items-center rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)] disabled:opacity-35"
              aria-label="Next page"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
