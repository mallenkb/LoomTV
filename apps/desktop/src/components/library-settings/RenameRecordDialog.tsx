import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Search } from 'lucide-react';
import { SETTINGS_INPUT_CLASS, SettingsDialog, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import type { MediaRenameRecord } from '@/shared/desktopProtocol';

const PAGE_SIZE = 50;
const KIND_LABELS = { video: 'Video', sidecar: 'Subtitle or artwork', folder: 'Folder' };

export default function RenameRecordDialog({ record, disabled, error, onClose }: {
  record: MediaRenameRecord;
  disabled: boolean;
  error: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const changes = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? record.changes.filter((change) => (
      change.fromPath.toLocaleLowerCase().includes(search) || change.toPath.toLocaleLowerCase().includes(search)
    )) : record.changes;
  }, [query, record.changes]);

  return (
    <SettingsDialog
      open
      onClose={onClose}
      busy={disabled}
      size="lg"
      title="Rename record"
      description={`Renamed ${new Date(record.createdAt).toLocaleString()}${record.undoneAt ? ' · Undone' : ''}. To go back to the first names, use Original file names.`}
      footerStart={<span role="status">{changes.length.toLocaleString()} {changes.length === 1 ? 'change' : 'changes'}</span>}
      footer={<Button size="sm" type="button" variant="outline" onClick={onClose} disabled={disabled}>Close</Button>}
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--loom-muted)]" aria-hidden="true" />
          <input
            type="search"
            aria-label="Find a file or folder in this batch"
            placeholder="Find a file or folder"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setShown(PAGE_SIZE); }}
            className={`${SETTINGS_INPUT_CLASS} pl-9`}
          />
        </div>
        {changes.length ? (
          <ul className="divide-y divide-[color-mix(in_srgb,var(--loom-text)_8%,transparent)] overflow-hidden rounded-lg border border-[var(--loom-control-border)]">
            {changes.slice(0, shown).map((change, index) => (
              <li key={`${change.fromPath}:${index}`} className="space-y-1 px-3 py-2.5 text-xs">
                <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--loom-faint)]">{KIND_LABELS[change.kind]}</p>
                <p className="select-text break-all text-[var(--loom-muted)]">{change.fromPath}</p>
                <p className="flex select-text items-start gap-1.5 break-all text-[var(--loom-text)]">
                  <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-[var(--loom-faint)]" aria-hidden="true" />
                  {change.toPath}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="py-6 text-center text-sm text-[var(--loom-muted)]">No recorded names match your search.</p>}
        {changes.length > shown ? (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setShown((current) => current + PAGE_SIZE)}>Show more</Button>
        ) : null}
        {error ? <SettingsDialogMessage>{error}</SettingsDialogMessage> : null}
      </div>
    </SettingsDialog>
  );
}
