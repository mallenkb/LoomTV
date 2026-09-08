import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import {
  compareSubtitleLanguages, downloadOnlineSubtitle, findOnlineSubtitles, subtitleLanguageLabel, subtitleSearchMatches,
  type OnlineSubtitle, type SubtitleVideo,
} from '../../lib/openSubtitlesV3';

export default function OpenSubtitlesV3Panel({ resolveVideo, selectedId, onSelect }: {
  resolveVideo: () => Promise<SubtitleVideo>;
  selectedId?: string;
  onSelect: (subtitle: OnlineSubtitle, text: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineSubtitle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
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
      const video = await resolveVideo();
      if (controller.signal.aborted) return;
      const found = await findOnlineSubtitles(video, controller.signal);
      if (!controller.signal.aborted) setResults(found);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not search OpenSubtitles v3.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
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
      if (!controller.signal.aborted) await onSelect(subtitle, text);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load this subtitle.');
    } finally {
      if (!controller.signal.aborted) setDownloading(null);
    }
  };
  return (
    <section className="space-y-2" aria-label="OpenSubtitles v3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-white">OpenSubtitles v3</h3>
        <button type="button" onClick={() => void search()} disabled={loading || downloading !== null}
          className="rounded-md bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20 disabled:opacity-50">
          {loading ? 'Searching...' : results ? 'Refresh results' : 'Find online subtitles'}
        </button>
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 transition-colors focus-within:bg-white/10">
        <Search className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => event.stopPropagation()} aria-label="Search OpenSubtitles languages or names"
          placeholder="Search languages or subtitles"
          style={{ border: 'none', boxShadow: 'none', outline: 'none', appearance: 'none', WebkitAppearance: 'none' }}
          className="min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-xs text-white !shadow-none !outline-none !ring-0 placeholder:text-white/50" />
      </label>
      {results === null && <p className="text-xs text-white/60">Searches OpenSubtitles v3 using this title's IMDb ID. Downloads only the subtitle you select.</p>}
      {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
      <div role="status" className="text-xs text-white/60">
        {downloading ? 'Downloading subtitle...' : results?.length === 0 ? 'No subtitles found for this title.'
          : results && !groups.length ? 'No subtitles match your search.' : ''}
      </div>
      <div className="h-auto overflow-hidden rounded-lg bg-white/5">
        {groups.map(([language, rows]) => (
          <details key={language} open={Boolean(query.trim()) || rows.some(subtitle => subtitle.id === selectedId) || undefined} className="border-b border-white/10 last:border-0">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-white">{language} <span className="font-normal text-white/50">{rows.length}</span></summary>
            {rows.map(subtitle => (
              <button type="button" key={subtitle.id} disabled={downloading !== null || loading} aria-pressed={selectedId === subtitle.id}
                onClick={() => void select(subtitle)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs disabled:opacity-50 ${selectedId === subtitle.id ? 'bg-[var(--loom-accent)]/25' : 'hover:bg-white/10'}`}>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-white">{subtitle.name}</span>
                  <span className="mt-1 block text-[10px] text-white/60">{subtitle.source}</span>
                </span>
                {selectedId === subtitle.id && <Check className="h-4 w-4 shrink-0 text-white" aria-hidden="true" />}
              </button>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}
