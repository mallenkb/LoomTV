import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import {
  compareSubtitleLanguages, downloadOnlineSubtitle, findOnlineSubtitles, subtitleLanguageLabel, subtitleSearchMatches,
  type OnlineSubtitle, type SubtitleVideo,
} from '../../lib/openSubtitlesV3';

/** Shift applied to the selected online subtitle, in seconds; negative shows it earlier. */
export type OnlineSubtitleTiming = { delay: number; setDelay: (seconds: number) => void };

/** What the panel lists and shows; `source` names the provider. */
export type PanelSubtitle = { id: string; language: string; name: string; source: string };

/** A subtitle source other than OpenSubtitles v3, such as installed add-ons. */
export type SubtitlePanelProvider<T extends PanelSubtitle> = {
  title: string;
  label: string;
  intro: string;
  find: (signal: AbortSignal) => Promise<T[]>;
  download: (subtitle: T, signal: AbortSignal) => Promise<string>;
};

function TimingControls({ delay, setDelay, id }: OnlineSubtitleTiming & { id: string }) {
  return (
    <div className="space-y-1.5 rounded-[8px] bg-black/25 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor={id} className="text-white/90">Timing</label>
        <span className="tabular-nums text-white/90" aria-live="polite">{delay > 0 ? '+' : ''}{delay.toFixed(2)}s</span>
      </div>
      <input id={id} type="range" min={-10} max={10} step={0.25} value={delay}
        onChange={event => setDelay(Number(event.target.value))}
        onKeyDown={event => event.stopPropagation()}
        aria-valuetext={`${Math.abs(delay).toFixed(2)} seconds ${delay < 0 ? 'earlier' : delay > 0 ? 'later' : 'offset'}`}
        className="w-full accent-[var(--loom-accent)]" />
      <div className="flex items-center justify-between gap-2 text-[11px] text-white/60">
        <span>Earlier</span>
        <button type="button" onClick={() => setDelay(0)} className="text-white/80 hover:text-white">Reset</button>
        <span>Later</span>
      </div>
    </div>
  );
}

export default function OpenSubtitlesV3Panel<T extends PanelSubtitle = OnlineSubtitle>({ resolveVideo, provider, selectedId, onSelect, timing }: {
  resolveVideo?: (signal: AbortSignal) => Promise<SubtitleVideo>;
  /** Replaces OpenSubtitles v3 with another source; listing and download stay on request. */
  provider?: SubtitlePanelProvider<T>;
  selectedId?: string;
  onSelect: (subtitle: T, text: string, signal: AbortSignal) => Promise<void>;
  /** Present while an online subtitle is showing; adds the timing button. */
  timing?: OnlineSubtitleTiming;
}) {
  const ids = useId();
  const headingId = `${ids}-heading`;
  const timingId = `${ids}-timing`;
  const syncId = `${ids}-sync`;
  const findSubtitles = async (signal: AbortSignal): Promise<T[]> => {
    if (provider) return provider.find(signal);
    if (!resolveVideo) throw new Error('This video cannot be matched for online subtitles.');
    const video = await resolveVideo(signal);
    signal.throwIfAborted();
    return await findOnlineSubtitles(video, signal) as unknown as T[];
  };
  const downloadSubtitle = (subtitle: T, signal: AbortSignal) => provider
    ? provider.download(subtitle, signal)
    : downloadOnlineSubtitle(subtitle as unknown as OnlineSubtitle, signal);
  const [timingOpen, setTimingOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    const controller = request.current;
    request.current = null;
    controller?.abort();
  }, []);
  const groups = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const result of results || []) {
      if (!subtitleSearchMatches(result.language, result.name, query, result.source)) continue;
      const language = subtitleLanguageLabel(result.language);
      const rows = map.get(language) || [];
      rows.push(result);
      map.set(language, rows);
    }
    return [...map].sort(([a], [b]) => compareSubtitleLanguages(a, b));
  }, [query, results]);
  const search = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setDownloading(null);
    setError('');
    try {
      const found = await findSubtitles(controller.signal);
      if (!controller.signal.aborted) setResults(found);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : `Could not search ${provider?.label || 'OpenSubtitles v3'}.`);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  const select = async (subtitle: T) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(false);
    setDownloading(subtitle.id);
    setError('');
    try {
      const text = await downloadSubtitle(subtitle, controller.signal);
      if (!controller.signal.aborted) await onSelect(subtitle, text, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load this subtitle.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setDownloading(null);
      }
    }
  };
  const cancel = () => {
    const controller = request.current;
    if (!controller) return;
    controller.abort();
    setLoading(false);
    setDownloading(null);
    setError('');
  };
  const busy = loading || downloading !== null;
  const status = downloading ? 'Downloading subtitle...' : results?.length === 0 ? 'No subtitles found for this title.'
    : results && !groups.length ? 'No subtitles match your search.' : '';
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-xs font-semibold text-white">{provider?.title || 'Online subtitles'}</h3>
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-wide text-white/70">{provider?.label || 'OpenSubtitles v3'}</p>
          {timing && (
            <button type="button" onClick={() => setTimingOpen(open => !open)}
              aria-expanded={timingOpen || timing.delay !== 0} aria-controls={timingId}
              aria-label="Online subtitle timing" title="Timing"
              className={`-my-1 rounded-[6px] p-1 transition-colors hover:bg-white/10 hover:text-white ${timingOpen || timing.delay !== 0 ? 'text-[var(--loom-accent)]' : 'text-white/70'}`}>
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg bg-white/10">
        <div className="space-y-2 p-3">
          {timing && (timingOpen || timing.delay !== 0) && (
            <div id={timingId}><TimingControls {...timing} id={syncId} /></div>
          )}
          <div className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] bg-black/25 px-3 py-2 transition-colors focus-within:bg-black/40">
              <Search className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden="true" />
              <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                onKeyDown={event => event.stopPropagation()} aria-label={`Search ${provider?.label || 'OpenSubtitles'} languages or names`}
                placeholder={results ? 'Filter by language or name' : 'Language or name'}
                style={{ border: 'none', boxShadow: 'none', outline: 'none', appearance: 'none', WebkitAppearance: 'none' }}
                className="min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-xs text-white !shadow-none !outline-none !ring-0 placeholder:text-white/50" />
            </label>
            {busy ? (
              <button type="button" onClick={cancel} aria-label={loading ? 'Cancel subtitle search' : 'Cancel subtitle download'}
                className="shrink-0 rounded-[8px] bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20">
                Cancel
              </button>
            ) : (
              <button type="button" onClick={() => void search()}
                aria-label={results ? 'Refresh online subtitles' : 'Find online subtitles'}
                className="shrink-0 rounded-[8px] bg-white/15 px-3 py-2 text-xs font-medium text-white hover:bg-white/25">
                {results ? 'Refresh' : 'Search'}
              </button>
            )}
          </div>
          {results === null && !loading && <p className="text-[11px] leading-relaxed text-white/60">{provider?.intro || 'Matches this video on IMDb and lists subtitles from OpenSubtitles v3. Only the one you pick is downloaded.'}</p>}
          {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
          {(status || loading) && <p className="text-xs text-white/60">{loading ? 'Searching...' : status}</p>}
        </div>
        {groups.length > 0 && <div className="max-h-80 overflow-y-auto border-t border-white/10">
          {groups.map(([language, rows]) => (
            <details key={language} open={Boolean(query.trim()) || rows.some(subtitle => subtitle.id === selectedId) || undefined}
              className="group border-t border-white/10 first:border-t-0">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[10px] leading-none font-semibold uppercase tracking-wider text-white/70 [&::-webkit-details-marker]:hidden">
                <span>{language} <span className="font-normal text-white/50">{rows.length}</span></span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              {rows.map(subtitle => (
                <button type="button" key={subtitle.id} disabled={busy} aria-pressed={selectedId === subtitle.id}
                  onClick={() => void select(subtitle)} title={subtitle.name}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${selectedId === subtitle.id ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${selectedId === subtitle.id ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-white">{subtitle.name}</span>
                    <span className="mt-0.5 block text-[10px] text-white/50">{subtitle.source}</span>
                  </span>
                </button>
              ))}
            </details>
          ))}
        </div>}
      </div>
      <div role="status" className="sr-only">{loading ? 'Searching...' : status}</div>
    </section>
  );
}
