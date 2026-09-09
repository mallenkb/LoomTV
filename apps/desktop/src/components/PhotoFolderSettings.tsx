import { useState } from 'react';
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/lib/navigation';
import { usePhotoLibrary } from '@/lib/photoLibrary';

export default function PhotoFolderSettings() {
  const { api, roots, loading, error, refresh } = usePhotoLibrary();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  if (!api) return null;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The photo library could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const scanRunning = roots.some((root) => root.scanning);

  return (
    <Card className="settings-panel">
      <CardHeader>
        <CardTitle>Photos</CardTitle>
        <CardDescription>
          Add local or mounted NAS folders. JPEG, PNG, and WebP photos keep their existing folder structure.
          Photos are currently available to the owner profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={busy || scanRunning}
            onClick={() => void act(async () => {
              const root = await api.add();
              if (root) await api.scan(root.id);
            })}
          >
            <FolderPlus className="mr-2 h-4 w-4" />
            Add photo folder
          </Button>
          {roots.length > 0 ? (
            <Link
              to="/photos"
              className="inline-flex h-10 items-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 text-sm font-medium text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)]"
            >
              Browse photos
            </Link>
          ) : null}
        </div>

        {loading ? <p role="status">Loading photo folders…</p> : null}
        {actionError || error ? (
          <p role="alert" className="text-sm text-red-400">
            {actionError || (error instanceof Error ? error.message : 'Photo folders could not be loaded.')}
          </p>
        ) : null}

        {roots.map((root) => (
          <div key={root.id} className="rounded-xl border border-[var(--loom-border)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{root.name}</p>
                <p className="break-all text-xs text-[var(--loom-muted)]">{root.path}</p>
                <p className="mt-2 text-sm text-[var(--loom-muted)]" role={root.scanning ? 'status' : undefined}>
                  {root.scanning
                    ? `Scanning, ${root.discovered.toLocaleString()} photos found`
                    : `${root.count.toLocaleString()} photos${root.state === 'unavailable' ? ', folder unavailable' : ''}`}
                </p>
                {root.message ? <p className="mt-2 text-sm text-[var(--loom-muted)]">{root.message}</p> : null}
              </div>
              <div className="flex gap-2">
                {root.scanning ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act(() => api.cancel(root.id))}>
                    Cancel scan
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    disabled={busy || scanRunning}
                    onClick={() => void act(() => api.scan(root.id))}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Scan
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy || root.scanning}
                  aria-label={`Remove ${root.name} from Photos`}
                  onClick={() => setRemoving(root.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {removing === root.id ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-sm">Remove this folder from Photos? Your original files will stay on disk.</p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    await api.remove(root.id);
                    setRemoving(null);
                  })}
                >
                  Remove folder
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                  Keep folder
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
