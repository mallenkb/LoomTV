import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import {
  LIVE_TV_SOURCE_ICON_OPTIONS,
  liveTvSourceIconPair,
  normalizeLiveTvSourceIcon,
} from '@/components/LiveTvSourceIcons';
import { useConfirm } from '@/components/ConfirmProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { desktopApi } from '@/lib/desktopApi';
import { notifyIptvSourcesChanged } from '@/lib/liveTvSources';
import type { IptvSourceIconId, IptvSourceSummary } from '@/shared/desktopProtocol';

const INPUT_CLASS = 'h-10 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The live TV request failed.';
}

function describeSource(source: IptvSourceSummary): string {
  const parts = [`${source.channelCount.toLocaleString()} channels`];
  if (source.programmeCount > 0) parts.push(`${source.programmeCount.toLocaleString()} guide entries`);
  if (source.refreshedAt > 0) parts.push(`updated ${new Date(source.refreshedAt).toLocaleString()}`);
  return parts.join(' · ');
}

function SourceIconPicker({
  name,
  value,
  onChange,
  disabled = false,
}: {
  name: string;
  value: IptvSourceIconId;
  onChange: (iconId: IptvSourceIconId) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Live TV source icon">
      {LIVE_TV_SOURCE_ICON_OPTIONS.map((option) => {
        const selected = option.id === value;
        const Icon = selected ? option.solid : option.outline;
        return (
          <label
            key={option.id}
            title={option.label}
            className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--loom-accent)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${
              selected
                ? 'border-[var(--loom-accent)] bg-[color-mix(in_srgb,var(--loom-accent)_18%,transparent)] text-[var(--loom-text)]'
                : 'border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] text-[var(--loom-muted)] hover:text-[var(--loom-text)]'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.id)}
              className="sr-only"
            />
            <Icon className="h-5 w-5" />
            <span>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Where a provider gets added. Saving a playlist here creates the source, pulls
 * its channels, and puts a tab for it in the sidebar — the page itself lives at
 * that tab, not in settings.
 */
export default function LiveTvSettingsSection() {
  const confirm = useConfirm();
  const [sources, setSources] = useState<IptvSourceSummary[]>([]);
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [name, setName] = useState('');
  const [iconId, setIconId] = useState<IptvSourceIconId>('general');
  const [editingSource, setEditingSource] = useState<IptvSourceSummary | null>(null);
  const [editPlaylistUrl, setEditPlaylistUrl] = useState('');
  const [editEpgUrl, setEditEpgUrl] = useState('');
  const [editName, setEditName] = useState('');
  const [editIconId, setEditIconId] = useState<IptvSourceIconId>('general');
  const [busyKey, setBusyKey] = useState<string | null>('load');
  const [pageError, setPageError] = useState('');
  const [editError, setEditError] = useState('');

  const applySources = useCallback((next: IptvSourceSummary[]) => {
    setSources(next);
    notifyIptvSourcesChanged(next);
  }, []);

  useEffect(() => {
    let mounted = true;
    desktopApi.listIptvSources()
      .then((next) => {
        if (mounted) setSources(next);
      })
      .catch((cause) => {
        if (mounted) setPageError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setBusyKey(null);
      });
    return () => { mounted = false; };
  }, []);

  const handleAdd = useCallback(async () => {
    const url = playlistUrl.trim();
    const sourceName = name.trim();
    if (!url || !sourceName) return;
    setBusyKey('add');
    setPageError('');
    try {
      const next = await desktopApi.addIptvSource({
        playlistUrl: url,
        epgUrl: epgUrl.trim() || undefined,
        name: sourceName,
        iconId,
      });
      applySources(next);
      setPlaylistUrl('');
      setEpgUrl('');
      setName('');
      setIconId('general');
    } catch (cause) {
      setPageError(errorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  }, [applySources, epgUrl, iconId, name, playlistUrl]);

  const openEdit = useCallback((source: IptvSourceSummary) => {
    setEditingSource(source);
    setEditPlaylistUrl(source.playlistUrl);
    setEditEpgUrl(source.epgUrl);
    setEditName(source.name);
    setEditIconId(normalizeLiveTvSourceIcon(source.iconId));
    setEditError('');
  }, []);

  const handleEditSave = useCallback(async () => {
    if (!editingSource || busyKey !== null) return;
    const nextPlaylistUrl = editPlaylistUrl.trim();
    const nextName = editName.trim();
    if (!nextPlaylistUrl || !nextName) return;
    const sourceId = editingSource.id;
    const urlsChanged = nextPlaylistUrl !== editingSource.playlistUrl
      || editEpgUrl.trim() !== editingSource.epgUrl;
    let saved = false;
    setBusyKey(`edit:${sourceId}`);
    setEditError('');
    setPageError('');
    try {
      applySources(await desktopApi.updateIptvSource(sourceId, {
        name: nextName,
        playlistUrl: nextPlaylistUrl,
        epgUrl: editEpgUrl.trim(),
        iconId: editIconId,
      }));
      saved = true;
      if (urlsChanged) {
        try {
          applySources(await desktopApi.refreshIptvSource(sourceId));
        } catch (cause) {
          setPageError(`The source was saved, but its refresh failed: ${errorMessage(cause)}`);
          await desktopApi.listIptvSources().then(applySources).catch(() => undefined);
        }
      }
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      setBusyKey(null);
      if (saved) window.requestAnimationFrame(() => setEditingSource(null));
    }
  }, [applySources, busyKey, editEpgUrl, editIconId, editName, editPlaylistUrl, editingSource]);

  const handleRefresh = useCallback(async (sourceId: string) => {
    setBusyKey(`refresh:${sourceId}`);
    setPageError('');
    try {
      applySources(await desktopApi.refreshIptvSource(sourceId));
    } catch (cause) {
      setPageError(errorMessage(cause));
      // The refresh error is also recorded on the source, so re-read the list
      // to show it on the row that failed.
      await desktopApi.listIptvSources().then(applySources).catch(() => undefined);
    } finally {
      setBusyKey(null);
    }
  }, [applySources]);

  const handleRemove = useCallback(async (source: IptvSourceSummary) => {
    const confirmed = await confirm({
      title: `Remove ${source.name}?`,
      description: 'Its sidebar tab, channels, and guide data are deleted. The provider itself is untouched.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    setBusyKey(`remove:${source.id}`);
    setPageError('');
    try {
      applySources(await desktopApi.removeIptvSource(source.id));
    } catch (cause) {
      setPageError(errorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  }, [applySources, confirm]);

  const isSavingEdit = Boolean(editingSource && busyKey === `edit:${editingSource.id}`);

  return (
    <div className="space-y-6">
      <Dialog
        open={Boolean(editingSource)}
        contentClassName="max-w-[min(92vw,48rem)] border border-[var(--loom-border)] bg-[var(--loom-surface)] p-0 text-[var(--loom-text)] shadow-2xl"
        onOpenChange={(open) => {
          if (open || isSavingEdit) return;
          setEditingSource(null);
          setEditError('');
        }}
      >
        <DialogContent className="space-y-5 p-6">
          <DialogHeader>
            <DialogTitle className="text-[var(--loom-text)]">Edit live TV source</DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">
              Change how this source appears or where LoomTV loads its playlist and guide.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            aria-busy={isSavingEdit}
            onSubmit={(event) => {
              event.preventDefault();
              void handleEditSave();
            }}
          >
            <label className="grid gap-1.5 text-sm text-[var(--loom-muted)]" htmlFor="edit-iptv-source-name">
              <span>Tab name</span>
              <input
                id="edit-iptv-source-name"
                type="text"
                required
                maxLength={60}
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                disabled={busyKey !== null}
                className={`${INPUT_CLASS} w-full`}
              />
            </label>
            <label className="grid gap-1.5 text-sm text-[var(--loom-muted)]" htmlFor="edit-iptv-playlist-url">
              <span>M3U playlist URL</span>
              <input
                id="edit-iptv-playlist-url"
                type="url"
                inputMode="url"
                required
                pattern="https://.*"
                value={editPlaylistUrl}
                onChange={(event) => setEditPlaylistUrl(event.target.value)}
                disabled={busyKey !== null}
                className={`${INPUT_CLASS} w-full`}
              />
            </label>
            <label className="grid gap-1.5 text-sm text-[var(--loom-muted)]" htmlFor="edit-iptv-epg-url">
              <span>XMLTV guide URL <span className="text-[var(--loom-faint)]">(optional)</span></span>
              <input
                id="edit-iptv-epg-url"
                type="url"
                inputMode="url"
                pattern="https://.*"
                value={editEpgUrl}
                onChange={(event) => setEditEpgUrl(event.target.value)}
                disabled={busyKey !== null}
                className={`${INPUT_CLASS} w-full`}
              />
            </label>
            <div className="space-y-2">
              <p className="text-sm text-[var(--loom-muted)]">Sidebar icon</p>
              <SourceIconPicker
                name="edit-iptv-source-icon"
                value={editIconId}
                onChange={setEditIconId}
                disabled={busyKey !== null}
              />
            </div>
            {editError ? (
              <p role="alert" className="text-sm text-red-300">{editError}</p>
            ) : null}
            {isSavingEdit ? (
              <p role="status" className="text-sm text-[var(--loom-muted)]">Saving changes…</p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                aria-disabled={isSavingEdit}
                onClick={() => {
                  if (isSavingEdit) return;
                  setEditingSource(null);
                  setEditError('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                aria-disabled={isSavingEdit}
                disabled={!editName.trim() || !editPlaylistUrl.trim()}
              >
                {isSavingEdit ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Add a live TV source</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Paste an M3U playlist URL from your provider. Add its XMLTV guide URL to get now-and-next
            listings; if the playlist advertises its own guide, LoomTV uses that. Playlist, guide, and
            channel URLs must all use HTTPS — plain-HTTP channels are skipped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAdd();
            }}
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="sr-only" htmlFor="iptv-source-name">Tab name</label>
              <input
                id="iptv-source-name"
                type="text"
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Tab name"
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="sr-only" htmlFor="iptv-playlist-url">M3U playlist URL</label>
              <input
                id="iptv-playlist-url"
                type="url"
                inputMode="url"
                required
                pattern="https://.*"
                value={playlistUrl}
                onChange={(event) => setPlaylistUrl(event.target.value)}
                placeholder="https://provider.example/playlist.m3u"
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="sr-only" htmlFor="iptv-epg-url">XMLTV guide URL</label>
              <input
                id="iptv-epg-url"
                type="url"
                inputMode="url"
                pattern="https://.*"
                value={epgUrl}
                onChange={(event) => setEpgUrl(event.target.value)}
                placeholder="https://provider.example/guide.xml.gz (optional)"
                className={INPUT_CLASS}
              />
              <Button type="submit" disabled={busyKey !== null || !name.trim() || !playlistUrl.trim()}>
                {busyKey === 'add' ? 'Adding…' : 'Add source'}
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--loom-muted)]">Sidebar icon</p>
              <SourceIconPicker
                name="new-iptv-source-icon"
                value={iconId}
                onChange={setIconId}
                disabled={busyKey !== null}
              />
            </div>
          </form>
          {pageError ? (
            <p role="alert" className="mt-3 text-sm text-red-300">{pageError}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Your live TV sources</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Each source has its own sidebar tab. Use Edit to change its name, URLs, or icon.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <p className="text-sm text-[var(--loom-muted)]">
              {busyKey === 'load' ? 'Loading…' : 'No live TV sources yet.'}
            </p>
          ) : (
            <ul className="space-y-3">
              {sources.map((source) => {
                const icons = liveTvSourceIconPair(source.iconId);
                const SourceIcon = icons.outline;
                return (
                <li
                  key={source.id}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3"
                >
                  <div
                    aria-hidden="true"
                    className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-muted)]"
                  >
                    <SourceIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">{source.name}</p>
                    <p className="truncate text-xs text-[var(--loom-faint)]">{source.playlistUrl}</p>
                    <p className="mt-1 text-xs text-[var(--loom-muted)]">{describeSource(source)}</p>
                    {source.skippedInsecure > 0 ? (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {source.skippedInsecure.toLocaleString()} channels were skipped because they stream over plain HTTP.
                      </p>
                    ) : null}
                    {source.refreshError ? (
                      <p role="alert" className="mt-1 text-xs text-red-300">
                        Last refresh failed: {source.refreshError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => openEdit(source)}
                      disabled={busyKey !== null}
                      aria-label={`Edit ${source.name}`}
                    >
                      <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void handleRefresh(source.id)}
                      disabled={busyKey !== null}
                    >
                      <RefreshCw
                        className={`mr-2 h-4 w-4 ${busyKey === `refresh:${source.id}` ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      Refresh
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => void handleRemove(source)}
                      disabled={busyKey !== null}
                      aria-label={`Remove ${source.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
