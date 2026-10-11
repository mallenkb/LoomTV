import { useCallback, useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { SettingsDisclosure, SettingsList, SettingsNote, SettingsRow, SettingsSelect } from '@/components/settings/SettingsLayout';
import SettingsDetailItem from '@/components/settings/SettingsDetailItem';
import { Button } from '@/components/ui/button';
import { desktopApi } from '@/lib/desktopApi';
import type { LibraryCleanupBatch } from '@/shared/desktopProtocol';

type CleanupMode = 'auto' | 'off';

const MODE_OPTIONS: { value: CleanupMode; label: string }[] = [
  { value: 'auto', label: 'Automatically' },
  { value: 'off', label: 'Off' },
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function dateLabel(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Settings for the automatic cleanup that clears leftover download files and
 * redundant subtitles on each sync and launch, with the recent cleanups and
 * a way to put any of them back.
 */
export default function LibraryCleanupSection({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<CleanupMode>('auto');
  const [batches, setBatches] = useState<LibraryCleanupBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [settings, history] = await Promise.all([desktopApi.getSettings(), desktopApi.libraryCleanupHistory()]);
      setMode(settings.cleanUpLibraryFiles === 'off' ? 'off' : 'auto');
      setBatches(history);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changeMode = async (next: CleanupMode) => {
    setMode(next);
    setError('');
    try {
      await desktopApi.saveSettings({ cleanUpLibraryFiles: next });
    } catch (cause) {
      setError(errorMessage(cause));
      void load();
    }
  };

  const restore = async (batch: LibraryCleanupBatch) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await desktopApi.restoreLibraryCleanup(batch.id);
      setStatus(result.skipped
        ? `Put back ${result.restored.toLocaleString()} ${result.restored === 1 ? 'file' : 'files'}. ${result.skipped.toLocaleString()} remain unresolved. Missing files, occupied destinations, or unavailable drives are listed in the cleanup record.`
        : `Put back ${result.restored.toLocaleString()} ${result.restored === 1 ? 'file' : 'files'}. Cleanup will leave them alone from now on.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const latest = batches.find((batch) => !batch.restoredAt);

  return (
    <>
      <SettingsRow
        title="Clean up download clutter"
        description="Moves leftover junk files and duplicate subtitles aside for 30 days. Anything unrecognized stays."
      >
        <SettingsSelect label="Clean up library folders" value={mode} options={MODE_OPTIONS} onChange={(value) => void changeMode(value)} disabled={busy} className="w-36" />
      </SettingsRow>
      {status ? <SettingsNote role="status">{status}</SettingsNote> : null}
      {error ? <SettingsNote role="alert" tone="error">{error}</SettingsNote> : null}
      {batches.length ? (
        <SettingsDisclosure
          title="Cleanup history"
          description={latest
            ? `Last cleanup ${dateLabel(latest.createdAt)}: ${latest.items.length.toLocaleString()} ${latest.items.length === 1 ? 'file' : 'files'} moved aside.`
            : 'Everything has been put back.'}
          summary={batches.length}
        >
          <div className="max-h-[45vh] overflow-y-auto overscroll-contain">
            {batches.map((batch) => (
              <SettingsDisclosure
                key={batch.id}
                title={`${dateLabel(batch.createdAt)} · ${batch.items.length.toLocaleString()} ${batch.items.length === 1 ? 'file' : 'files'}`}
                description={batch.restoredAt ? 'Put back' : batch.items.some((item) => item.error) ? 'Needs attention' : batch.expiresAt <= Date.now() ? 'Retention ended' : `Kept until ${dateLabel(batch.expiresAt)}`}
                actions={!batch.restoredAt ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void restore(batch)} disabled={disabled || busy} className="gap-1.5">
                    <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Put back
                  </Button>
                ) : null}
              >
                <SettingsList label="Files in this cleanup" maxHeight="max-h-60">
                  {batch.items.map((item) => (
                    <SettingsDetailItem key={`${item.folder}/${item.name}`} title={item.name} detail={item.folder} reason={`${item.reason}${item.state ? ` · ${item.state}` : ''}${item.error ? ` · ${item.error}` : ''}`} />
                  ))}
                </SettingsList>
              </SettingsDisclosure>
            ))}
          </div>
        </SettingsDisclosure>
      ) : null}
    </>
  );
}
