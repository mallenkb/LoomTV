import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryHealthReport } from '@/shared/desktopProtocol';

function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-panel-soft rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={count === 0}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-3 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2">
          {count > 0 ? (open ? <ChevronDown className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" /> : <ChevronRight className="h-4 w-4 shrink-0 text-[var(--loom-muted)]" />) : <span className="w-4" />}
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-white">{title}</span>
            <span className="block text-xs text-[var(--loom-muted)]">{hint}</span>
          </span>
        </span>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${count > 0 ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'}`}>
          {count > 0 ? count.toLocaleString() : 'All good'}
        </span>
      </button>
      {open && count > 0 ? <ul className="max-h-64 space-y-1.5 overflow-y-auto px-9 pb-3 text-xs">{children}</ul> : null}
    </div>
  );
}

/**
 * Everything in the library that needs a look, in one place: unmatched
 * titles, missing episodes, shows split across folders, titles with no
 * subtitles, and files the rename preview leaves alone.
 */
export default function LibraryHealthCard({ disabled }: { disabled: boolean }) {
  const [report, setReport] = useState<LibraryHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await desktopApi.libraryHealth());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The library check could not run.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!disabled) void load();
  }, [disabled, load]);

  return (
    <Card className="settings-panel">
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base text-white">Library health</CardTitle>
          <CardDescription className="mt-1 text-[var(--loom-muted)]">Titles and files that need a look.</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={disabled || loading} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Checking…' : 'Check again'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {disabled ? <p className="text-xs text-[var(--loom-muted)]">Available when the sync finishes.</p> : null}
        {error ? <p role="alert" className="text-xs text-red-200">{error}</p> : null}
        {report ? (
          <>
            <Section title="Not matched" count={report.unmatched.length} hint="LoomTV could not identify these titles. Open one and use Fix Match.">
              {report.unmatched.map((entry) => (
                <li key={entry.mediaId} className="text-[var(--loom-text)]">{entry.title}<span className="text-[var(--loom-muted)]"> · {entry.fileName}</span></li>
              ))}
            </Section>
            <Section title="Missing episodes" count={report.missingEpisodes.reduce((total, show) => total + show.count, 0)} hint="Aired episodes missing from seasons you have. TV shows only.">
              {report.missingEpisodes.map((show) => (
                <li key={show.mediaId} className="text-[var(--loom-text)]">
                  {show.title}<span className="text-[var(--loom-muted)]"> · {show.examples.join(', ')}{show.count > show.examples.length ? ` and ${show.count - show.examples.length} more` : ''}</span>
                </li>
              ))}
            </Section>
            <Section title="Shows in more than one folder" count={report.splitShows.length} hint="The same show found in separate folders. Move them into one folder.">
              {report.splitShows.map((show) => (
                <li key={show.title} className="text-[var(--loom-text)]">{show.title}<span className="block break-all text-[var(--loom-muted)]">{show.folders.join(' · ')}</span></li>
              ))}
            </Section>
            <Section title="No subtitles" count={report.noSubtitles.reduce((total, entry) => total + entry.files, 0)} hint="Files with no subtitle file and no subtitles inside the video.">
              {report.noSubtitles.map((entry) => (
                <li key={entry.mediaId} className="text-[var(--loom-text)]">{entry.title}<span className="text-[var(--loom-muted)]"> · {entry.files.toLocaleString()} {entry.files === 1 ? 'file' : 'files'}</span></li>
              ))}
            </Section>
            <Section title="Left out of renaming" count={report.renameSkipped.length} hint="Files the rename leaves as they are, and why.">
              {report.renameSkipped.map((entry, index) => (
                <li key={`${entry.fileName}:${index}`} className="text-[var(--loom-text)]">
                  {entry.title}<span className="text-[var(--loom-muted)]"> · {entry.fileName}</span>
                  <span className="block text-[var(--loom-muted)]">{entry.reason}</span>
                </li>
              ))}
            </Section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
