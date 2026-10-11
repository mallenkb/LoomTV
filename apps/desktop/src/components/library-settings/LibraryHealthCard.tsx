import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsDisclosure, SettingsGroup, SettingsList, SettingsNote } from '@/components/settings/SettingsLayout';
import SettingsDetailItem from '@/components/settings/SettingsDetailItem';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryHealthReport } from '@/shared/desktopProtocol';

/** One check. Checks with nothing to report are left out entirely. */
function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <SettingsDisclosure title={title} description={hint} summary={count} summaryTone="warning">
      <SettingsList label={`${title} details`}>{children}</SettingsList>
    </SettingsDisclosure>
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

  const issueCount = report
    ? report.unmatched.length + report.missingEpisodes.length + report.splitShows.length + report.noSubtitles.length + report.renameSkipped.length
    : 0;

  return (
    <SettingsGroup
      title="Library health"
      action={(
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={disabled || loading} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Checking…' : 'Check again'}
        </Button>
      )}
    >
        {disabled ? <SettingsNote>Available when the sync finishes.</SettingsNote> : null}
        {error ? <SettingsNote role="alert" tone="error">{error}</SettingsNote> : null}
        {!disabled && !error && !report ? <SettingsNote role="status">Checking your library…</SettingsNote> : null}
        {report && issueCount === 0 ? <SettingsNote role="status" tone="ok">Nothing needs attention.</SettingsNote> : null}
        {report ? (
          <>
            <Section title="Not matched" count={report.unmatched.length} hint="LoomTV could not identify these titles. Open one and use Fix Match.">
              {report.unmatched.map((entry) => (
                <SettingsDetailItem key={entry.mediaId} title={entry.title} detail={entry.fileName} />
              ))}
            </Section>
            <Section title="Not added yet" count={report.missingEpisodes.reduce((total, show) => total + show.count, 0)} hint="Episodes that have aired, in seasons you have, but aren't in your library. TV shows only.">
              {report.missingEpisodes.map((show) => (
                <SettingsDetailItem key={show.mediaId} title={show.title} detail={`${show.examples.join(', ')}${show.count > show.examples.length ? ` and ${show.count - show.examples.length} more` : ''}`} />
              ))}
            </Section>
            <Section title="Shows in more than one folder" count={report.splitShows.length} hint="The same show found in separate folders. Move them into one folder.">
              {report.splitShows.map((show) => (
                <SettingsDetailItem key={show.title} title={show.title} detail={show.folders.join(' · ')} />
              ))}
            </Section>
            <Section title="No subtitles" count={report.noSubtitles.reduce((total, entry) => total + entry.files, 0)} hint="Files with no subtitle file and no subtitles inside the video.">
              {report.noSubtitles.map((entry) => (
                <SettingsDetailItem key={entry.mediaId} title={entry.title} reason={`${entry.files.toLocaleString()} ${entry.files === 1 ? 'file' : 'files'}`} />
              ))}
            </Section>
            <Section title="Left out of renaming" count={report.renameSkipped.length} hint="Files the rename leaves as they are, and why.">
              {report.renameSkipped.map((entry, index) => (
                <SettingsDetailItem key={`${entry.fileName}:${index}`} title={entry.title} detail={entry.fileName} reason={entry.reason} />
              ))}
            </Section>
          </>
        ) : null}
    </SettingsGroup>
  );
}
