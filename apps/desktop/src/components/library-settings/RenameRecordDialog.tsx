import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} contentClassName="max-w-3xl border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename record</DialogTitle>
          <DialogDescription className="text-[var(--loom-muted)]">
            Names and locations for the rename on {new Date(record.createdAt).toLocaleString()}. Use Original imports to restore the first saved state.
          </DialogDescription>
        </DialogHeader>
        <label className="mt-4 block text-sm">
          Find a file or folder in this batch
          <input
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setShown(PAGE_SIZE); }}
            className="mt-1 block w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 py-2 text-[var(--loom-text)]"
          />
        </label>
        <p className="my-3 text-xs text-[var(--loom-muted)]" role="status">
          {changes.length.toLocaleString()} recorded {changes.length === 1 ? 'change' : 'changes'}{record.undoneAt ? ' · Undone' : ''}
        </p>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {changes.slice(0, shown).map((change, index) => (
            <div key={`${change.fromPath}:${index}`} className="rounded-lg bg-[var(--loom-bg)] p-3 text-xs">
              <p className="mb-2 font-semibold">{KIND_LABELS[change.kind]}</p>
              <dl className="space-y-2">
                <div>
                  <dt className="text-[var(--loom-muted)]">Name before this batch</dt>
                  <dd className="mt-0.5 select-text break-all">{change.fromPath}</dd>
                </div>
                <div>
                  <dt className="text-[var(--loom-muted)]">Renamed to</dt>
                  <dd className="mt-0.5 select-text break-all">{change.toPath}</dd>
                </div>
              </dl>
            </div>
          ))}
          {changes.length === 0 ? <p className="text-sm text-[var(--loom-muted)]">No recorded names match your search.</p> : null}
          {changes.length > shown ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setShown((current) => current + PAGE_SIZE)}>Show more names</Button>
          ) : null}
        </div>
        {error ? <p role="alert" className="mt-3 text-xs text-red-200">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={disabled}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
