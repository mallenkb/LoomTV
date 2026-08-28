import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import {
  LIVE_TV_SOURCE_ICON_OPTIONS,
  liveTvSourceIconPair,
  normalizeLiveTvSourceIcon,
} from '@/components/LiveTvSourceIcons';
import { useConfirm } from '@/components/ConfirmProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { desktopApi } from '@/lib/desktopApi';
import { notifyIptvSourcesChanged } from '@/lib/liveTvSources';
import type { IptvSourceIconId, IptvSourceSummary } from '@/shared/desktopProtocol';

const INPUT_CLASS = 'h-10 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-white outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]';

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
  value,
  onChange,
  disabled = false,
}: {
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
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:opacity-50 ${
              selected
                ? 'border-[var(--loom-accent)] bg-[color-mix(in_srgb,var(--loom-accent)_18%,transparent)] text-[var(--loom-accent)]'
                : 'border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] text-[var(--loom-muted)] hover:text-white'
            }`}
          >
            <Icon className="h-5 w-5" />
            <span>{option.label}</span>
          </button>
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
  const [editingIconSourceId, setEditingIconSourceId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>('load');
  const [error, setError] = useState('');

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
        if (mounted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setBusyKey(null);
      });
    return () => { mounted = false; };
  }, []);

  const handleAdd = useCallback(async () => {
    const url = playlistUrl.trim();
    if (!url) return;
    setBusyKey('add');
    setError('');
    try {
      const next = await desktopApi.addIptvSource({
        playlistUrl: url,
        epgUrl: epgUrl.trim() || undefined,
        name: name.trim() || undefined,
        iconId,
      });
      applySources(next);
      setPlaylistUrl('');
      setEpgUrl('');
      setName('');
      setIconId('general');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  }, [applySources, epgUrl, iconId, name, playlistUrl]);

  const handleIconChange = useCallback(async (source: IptvSourceSummary, nextIconId: IptvSourceIconId) => {
    setBusyKey(`icon:${source.id}`);
    setError('');
    try {
      applySources(await desktopApi.updateIptvSource(source.id, { iconId: nextIconId }));
      setEditingIconSourceId(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  }, [applySources]);

  const handleRefresh = useCallback(async (sourceId: string) => {
    setBusyKey(`refresh:${sourceId}`);
    setError('');
    try {
      applySources(await desktopApi.refreshIptvSource(sourceId));
    } catch (cause) {
      setError(errorMessage(cause));
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
    setError('');
    try {
      applySources(await desktopApi.removeIptvSource(source.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  }, [applySources, confirm]);

  return (
    <div className="space-y-6">
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
              <label className="sr-only" htmlFor="iptv-source-name">Tab name</label>
              <input
                id="iptv-source-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Tab name (optional)"
                className={`${INPUT_CLASS} sm:max-w-56`}
              />
              <Button type="submit" disabled={busyKey !== null || !playlistUrl.trim()}>
                {busyKey === 'add' ? 'Adding…' : 'Add source'}
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--loom-muted)]">Sidebar icon</p>
              <SourceIconPicker value={iconId} onChange={setIconId} disabled={busyKey !== null} />
            </div>
          </form>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Your live TV sources</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Each source has its own sidebar tab. Select its icon to change it.
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
                const normalizedIconId = normalizeLiveTvSourceIcon(source.iconId);
                const isEditingIcon = editingIconSourceId === source.id;
                return (
                <li
                  key={source.id}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3"
                >
                  <button
                    type="button"
                    onClick={() => setEditingIconSourceId(isEditingIcon ? null : source.id)}
                    disabled={busyKey !== null}
                    aria-label={`Choose icon for ${source.name}`}
                    aria-expanded={isEditingIcon}
                    className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-transparent bg-[var(--loom-surface-3)] text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-control-border)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] disabled:opacity-50"
                  >
                    <SourceIcon className="h-5 w-5" />
                  </button>
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
                  {isEditingIcon ? (
                    <div className="w-full border-t border-[var(--loom-border)] pt-3">
                      <p className="mb-2 text-xs font-medium text-[var(--loom-muted)]">Choose sidebar icon</p>
                      <SourceIconPicker
                        value={normalizedIconId}
                        onChange={(nextIconId) => void handleIconChange(source, nextIconId)}
                        disabled={busyKey !== null}
                      />
                    </div>
                  ) : null}
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
