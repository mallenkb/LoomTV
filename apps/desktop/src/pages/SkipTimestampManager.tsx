import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { desktopApi, type LibraryPayload, type ManagedMediaSegment, type MediaSegmentType, type SkipAnalysisSettings } from '@/lib/desktopApi';

const TYPES = ['intro', 'recap', 'credits', 'preview'] as const;
const PREVIEW_LEASE_KEY = 'skip-timestamp-manager-preview';
type MarkerForm = { candidateId?: string; mediaId: string; season: string; episode: string; type: MediaSegmentType; start: string; end: string };

export default function SkipTimestampManager({
  settings,
  onSettingsChange,
  onRun,
  onSaveSettings,
}: {
  settings: SkipAnalysisSettings;
  onSettingsChange: (settings: SkipAnalysisSettings) => void;
  onRun: (scope: { mediaId: string; season?: number }) => void;
  onSaveSettings: () => void | boolean | Promise<void | boolean>;
}) {
  const [segments, setSegments] = useState<ManagedMediaSegment[]>([]);
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState('');
  const [selectedSeason, setSelectedSeason] = useState(0);
  const [selectedEpisode, setSelectedEpisode] = useState(0);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState<MarkerForm>({ mediaId: '', season: '0', episode: '0', type: 'intro', start: '0', end: '90' });
  const [preview, setPreview] = useState<{ url: string; start: number; end: number } | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  const items = useMemo(() => [...(library?.movies || []), ...(library?.tvShows || []), ...(library?.animeShows || [])]
    .sort((left, right) => left.title.localeCompare(right.title)), [library]);
  const selectedItem = items.find((item) => item.id === selectedMediaId);
  const seasons = useMemo(() => selectedItem?.type === 'movie'
    ? [0]
    : [...new Set((selectedItem?.episodeFiles || []).map((file) => file.season))].sort((a, b) => a - b), [selectedItem]);
  const episodes = useMemo(() => selectedItem?.type === 'movie'
    ? [0]
    : [...new Set((selectedItem?.episodeFiles || []).filter((file) => file.season === selectedSeason).map((file) => file.episode))].sort((a, b) => a - b), [selectedItem, selectedSeason]);
  const visible = segments.filter((segment) => `${segment.type} ${segment.source} ${segment.status}`.includes(filter.toLowerCase()));
  const excludedKey = `${selectedMediaId}:${selectedSeason}`;
  const seasonExcluded = settings.exclusions.seasons.includes(excludedKey);

  const refresh = async (mediaId = selectedMediaId, season = selectedSeason, episode = selectedEpisode) => {
    if (!mediaId) { setSegments([]); return; }
    setSegments(await desktopApi.getManagedMediaSegments({ mediaId, season, episode }));
  };

  useEffect(() => { void desktopApi.getLibrary().then((value) => { setLibrary(value); setSelectedMediaId(value.movies[0]?.id || value.tvShows[0]?.id || value.animeShows?.[0]?.id || ''); }); }, []);
  useEffect(() => () => { void desktopApi.setPlaybackActivity(PREVIEW_LEASE_KEY, false); }, []);
  useEffect(() => {
    const nextSeason = seasons.includes(selectedSeason) ? selectedSeason : (seasons[0] ?? 0);
    if (nextSeason !== selectedSeason) setSelectedSeason(nextSeason);
  }, [seasons, selectedSeason]);
  useEffect(() => {
    const nextEpisode = episodes.includes(selectedEpisode) ? selectedEpisode : (episodes[0] ?? 0);
    if (nextEpisode !== selectedEpisode) setSelectedEpisode(nextEpisode);
  }, [episodes, selectedEpisode]);
  useEffect(() => {
    if (!selectedMediaId) return;
    setForm((current) => ({ ...current, candidateId: undefined, mediaId: selectedMediaId, season: String(selectedSeason), episode: String(selectedEpisode) }));
    void desktopApi.getManagedMediaSegments({ mediaId: selectedMediaId, season: selectedSeason, episode: selectedEpisode }).then(setSegments);
  }, [selectedEpisode, selectedMediaId, selectedSeason]);

  const updateCandidate = async (id: string, patch: { status?: ManagedMediaSegment['status']; type?: MediaSegmentType }) => {
    await desktopApi.updateManagedMediaSegment(id, patch);
    await refresh();
  };
  const selectForEdit = (segment: ManagedMediaSegment) => setForm({
    candidateId: segment.source === 'manual' ? segment.id : undefined,
    mediaId: segment.mediaId,
    season: String(segment.season),
    episode: String(segment.episode),
    type: segment.type,
    start: String(segment.startMs / 1000),
    end: segment.endMs === null ? '' : String(segment.endMs / 1000),
  });
  const saveManual = async () => {
    await desktopApi.saveManualMediaSegment({
      candidateId: form.candidateId,
      mediaId: form.mediaId.trim(), season: Number(form.season) || 0, episode: Number(form.episode) || 0,
      type: form.type, startMs: Math.round((Number(form.start) || 0) * 1000),
      endMs: form.end.trim() ? Math.round(Number(form.end) * 1000) : null,
    });
    setForm((current) => ({ ...current, candidateId: undefined }));
    await refresh();
  };
  const filePathForForm = () => {
    const item = items.find((candidate) => candidate.id === form.mediaId.trim());
    if (!item) return '';
    if (item.filePath) return item.filePath;
    return item.episodeFiles?.find((episode) => episode.season === (Number(form.season) || 0) && episode.episode === (Number(form.episode) || 0))?.filePath || '';
  };
  const previewForm = async () => {
    const filePath = filePathForForm();
    if (!filePath) return;
    const start = Math.max(0, Number(form.start) || 0);
    const end = form.end.trim() ? Math.max(start + 1, Number(form.end) || start + 1) : start + 90;
    const stream = await desktopApi.getStreamUrl(filePath);
    setPreview({ url: stream.url, start, end });
  };
  const rescanSeason = async () => {
    const saved = await onSaveSettings();
    if (saved === false) return;
    onRun({ mediaId: selectedMediaId, season: selectedSeason });
  };

  return <div className="space-y-5">
      <div className="grid gap-3 rounded-lg bg-[var(--loom-surface-2)] p-4 md:grid-cols-3">
        <label className="text-xs text-[var(--loom-muted)]">Library title<select aria-label="Library title" value={selectedMediaId} onChange={(event) => setSelectedMediaId(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white">{items.map((item) => <option key={item.id} value={item.id}>{item.type === 'movie' ? 'Movie' : item.type === 'anime' ? 'Anime' : 'TV'} · {item.title}</option>)}</select></label>
        <label className="text-xs text-[var(--loom-muted)]">Season<select aria-label="Season" value={selectedSeason} onChange={(event) => setSelectedSeason(Number(event.target.value))} className="mt-1 w-full rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white">{seasons.map((season) => <option key={season} value={season}>{selectedItem?.type === 'movie' ? 'Movie' : `Season ${season}`}</option>)}</select></label>
        <label className="text-xs text-[var(--loom-muted)]">Episode<select aria-label="Episode" value={selectedEpisode} onChange={(event) => setSelectedEpisode(Number(event.target.value))} className="mt-1 w-full rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white">{episodes.map((episode) => <option key={episode} value={episode}>{selectedItem?.type === 'movie' ? 'Feature' : `Episode ${episode}`}</option>)}</select></label>
        <div className="flex flex-wrap gap-2 md:col-span-3">
          <select aria-label="Season analysis mode" value={settings.seasonOverrides[excludedKey] || 'full'} onChange={(event) => onSettingsChange({ ...settings, seasonOverrides: { ...settings.seasonOverrides, [excludedKey]: event.target.value as 'full' | 'chapter-only' | 'providers-only' } })} className="rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-xs text-white"><option value="full">Full analysis</option><option value="chapter-only">Chapter only</option><option value="providers-only">Providers only</option></select>
          <Button type="button" variant="outline" disabled={!settings.enabled || !selectedMediaId} onClick={() => void rescanSeason()}>Save &amp; manually scan season</Button>
          <Button type="button" variant="outline" disabled={!selectedMediaId} onClick={() => onSettingsChange({ ...settings, exclusions: { ...settings.exclusions, seasons: seasonExcluded ? settings.exclusions.seasons.filter((value) => value !== excludedKey) : [...settings.exclusions.seasons, excludedKey] } })}>{seasonExcluded ? 'Include season' : 'Exclude season'}</Button>
          <Button type="button" variant="outline" disabled={!selectedMediaId} onClick={async () => { await desktopApi.eraseManagedMediaSegments({ mediaId: selectedMediaId, season: selectedSeason }); await refresh(); }}>Erase season automatic markers</Button>
        </div>
      </div>

      <div className="rounded-lg bg-[var(--loom-surface-2)] p-4">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-white">{form.candidateId ? 'Edit manual marker' : 'Add manual marker'}</h3>{form.candidateId && <Button type="button" variant="outline" onClick={() => setForm((current) => ({ ...current, candidateId: undefined }))}>Add new instead</Button>}</div>
        <div className="mt-3 grid gap-2 md:grid-cols-6">
          <select aria-label="Manual marker type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as MediaSegmentType })} className="rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white">{TYPES.map((type) => <option key={type}>{type}</option>)}</select>
          <input aria-label="Marker start seconds" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} inputMode="decimal" placeholder="Start seconds" className="rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white" />
          <input aria-label="Marker end seconds" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} inputMode="decimal" placeholder="End seconds" className="rounded-md border border-[var(--loom-border)] bg-[var(--loom-bg)] px-2 py-2 text-sm text-white" />
          <div className="flex gap-2 md:col-span-3"><Button type="button" disabled={!form.mediaId} onClick={() => void previewForm()} variant="outline">Preview</Button><Button type="button" disabled={!form.mediaId} onClick={() => void saveManual()}>Save marker</Button></div>
        </div>
        {preview && <div className="mt-4 rounded-lg bg-black p-2"><video ref={previewRef} src={preview.url} controls autoPlay className="max-h-64 w-full" onPlay={() => void desktopApi.setPlaybackActivity(PREVIEW_LEASE_KEY, true, 'Timestamp preview')} onPause={() => void desktopApi.setPlaybackActivity(PREVIEW_LEASE_KEY, false)} onEnded={() => void desktopApi.setPlaybackActivity(PREVIEW_LEASE_KEY, false)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = preview.start; }} onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= preview.end) event.currentTarget.pause(); }} /></div>}
      </div>

      <input aria-label="Filter selected episode markers" value={filter} onChange={(event) => setFilter(event.target.value.toLowerCase())} placeholder="Filter markers by type, source, or state" className="w-full rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 py-2 text-sm text-white" />
      <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">{visible.map((segment) => <div key={segment.id} className="grid items-center gap-2 rounded-md border border-[var(--loom-border)] px-3 py-2 text-xs text-[var(--loom-text)] md:grid-cols-[95px_1fr_110px_auto]">
        <select value={segment.type} disabled={segment.source === 'manual'} aria-label={`Segment type for ${segment.type}`} onChange={(event) => void updateCandidate(segment.id, { type: event.target.value as MediaSegmentType })} className="rounded bg-black px-2 py-1 disabled:opacity-60">{TYPES.map((type) => <option key={type}>{type}</option>)}</select>
        <button type="button" onClick={() => selectForEdit(segment)} className="text-left"><span>{(segment.startMs / 1000).toFixed(1)}–{segment.endMs === null ? 'end' : (segment.endMs / 1000).toFixed(1)}s</span><span className="ml-2 text-[var(--loom-muted)]">{segment.source} · {Math.round(segment.confidence * 100)}%{segment.analysisMetadata?.detector ? ` · ${segment.analysisMetadata.detector}` : ''}</span></button>
        <span className={segment.status === 'active' ? 'text-emerald-300' : segment.status === 'review' ? 'text-amber-300' : 'text-red-300'}>{segment.status}</span>
        <div className="flex gap-1">{segment.source !== 'manual' && <><Button type="button" variant="outline" onClick={() => void updateCandidate(segment.id, { status: 'active' })}>{segment.status === 'rejected' ? 'Restore' : 'Approve'}</Button><Button type="button" variant="outline" onClick={() => void updateCandidate(segment.id, { status: 'rejected' })}>Reject</Button></>}{segment.source === 'manual' && <Button type="button" variant="outline" onClick={async () => { await desktopApi.deleteManualMediaSegment({ candidateId: segment.id, mediaId: segment.mediaId, season: segment.season, episode: segment.episode, type: segment.type }); await refresh(); }}>Delete</Button>}</div>
      </div>)}{!visible.length && <p className="py-8 text-center text-sm text-[var(--loom-muted)]">No markers for this title, season, and episode yet. You can manually scan the season or add one above.</p>}</div>
  </div>;
}
