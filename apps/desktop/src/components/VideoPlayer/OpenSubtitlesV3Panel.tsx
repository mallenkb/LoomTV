import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import {
  compareSubtitleLanguages, downloadOnlineSubtitle, findOnlineSubtitles, subtitleLanguageLabel, subtitleSearchMatches,
  type OnlineSubtitle, type SubtitleVideo,
} from '../../lib/openSubtitlesV3';

export default function OpenSubtitlesV3Panel({ resolveVideo, selectedId, onSelect }: {
  resolveVideo: (signal: AbortSignal) => Promise<SubtitleVideo>;
  selectedId?: string;
  onSelect: (subtitle: OnlineSubtitle, text: string, signal: AbortSignal) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineSubtitle[] | null>(null);
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
    const map = new Map<string, OnlineSubtitle[]>();
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
      const video = await resolveVideo(controller.signal);
      if (controller.signal.aborted) return;
      const found = await findOnlineSubtitles(video, controller.signal);
      if (!controller.signal.aborted) setResults(found);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not search OpenSubtitles v3.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  const select = async (subtitle: OnlineSubtitle) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(false);
    setDownloading(subtitle.id);
    setError('');
    try {
      const text = await downloadOnlineSubtitle(subtitle, controller.signal);
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
    <section aria-labelledby="online-subtitles-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="online-subtitles-heading" className="text-xs font-semibold text-white">Online subtitles</h3>
        <p className="text-[10px] uppercase tracking-wide text-white/70">OpenSubtitles v3</p>
      </div>
      <div className="overflow-hidden rounded-lg bg-white/10">
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] bg-black/25 px-3 py-2 transition-colors focus-within:bg-black/40">
              <Search className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden="true" />
              <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                onKeyDown={event => event.stopPropagation()} aria-label="Search OpenSubtitles languages or names"
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
          {results === null && !loading && <p className="text-[11px] leading-relaxed text-white/60">Matches this video on IMDb and lists subtitles from OpenSubtitles v3. Only the one you pick is downloaded.</p>}
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
