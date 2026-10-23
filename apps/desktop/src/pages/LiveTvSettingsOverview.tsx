import { useEffect, useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { liveTvSourceIconPair } from '@/components/LiveTvSourceIcons';
import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SettingsBadge, SettingsDisclosure, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow } from '@/components/settings/SettingsLayout';
import { desktopApi } from '@/lib/desktopApi';
import { iptvSourceDisplayName, notifyIptvSourcesChanged } from '@/lib/liveTvSources';
import type { IptvSourceSummary } from '@/shared/desktopProtocol';
import LiveTvSettingsSection from './LiveTvSettingsSection';

const updatedLabel = (value: number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Live TV sources at a glance. Adding and editing open the full source form. */
export default function LiveTvSettingsOverview() {
  const confirm = useConfirm();
  const [sources, setSources] = useState<IptvSourceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [manager, setManager] = useState<{ kind: 'add' } | { kind: 'edit'; source: IptvSourceSummary } | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      setLoading(true);
      setError(null);
      void desktopApi.listIptvSources()
        .then((next) => { if (mounted) setSources(next); })
        .catch((cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : 'Could not load live TV sources.'); })
        .finally(() => { if (mounted) setLoading(false); });
    };
    const changed = (event: Event) => {
      const next = (event as CustomEvent<readonly IptvSourceSummary[] | undefined>).detail;
      if (next) {
        setSources([...next]);
        setError(null);
        setLoading(false);
      } else load();
    };
    load();
    window.addEventListener('loomtv:iptv-sources-changed', changed);
    return () => {
      mounted = false;
      window.removeEventListener('loomtv:iptv-sources-changed', changed);
    };
  }, [revision]);

  // Channel checks run in the background; poll until they finish.
  const checking = sources.some((source) => source.health.checking);
  useEffect(() => {
    if (!checking) return undefined;
    let active = true;
    const timer = window.setInterval(() => {
      void desktopApi.listIptvSources().then((next) => { if (active) setSources(next); }).catch(() => undefined);
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [checking]);

  const closeManager = () => {
    setManager(null);
    setRevision((value) => value + 1);
  };
  const removeSource = async (source: IptvSourceSummary) => {
    const approved = await confirm({
      title: `Remove ${iptvSourceDisplayName(source.name)}?`,
      description: 'Its sidebar tab, channels, and guide data are removed.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!approved) return;
    setRemoving(source.id);
    setError(null);
    try {
      const next = await desktopApi.removeIptvSource(source.id);
      setSources(next);
      notifyIptvSourcesChanged(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the live TV source.');
    } finally {
      setRemoving(null);
    }
  };
  const refreshSource = async (sourceId: string) => {
    setRefreshing(sourceId);
    setError(null);
    try {
      const next = await desktopApi.refreshIptvSource(sourceId);
      setSources(next);
      notifyIptvSourcesChanged(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh the live TV source.');
    } finally {
      setRefreshing(null);
    }
  };
  const busy = refreshing !== null || removing !== null;

  return (
    <div>
      <SettingsPageHeader title="Live TV" description="IPTV playlists, their program guides, and channel health." />

      <SettingsGroup
        title="Sources"
        action={(
          <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={() => setManager({ kind: 'add' })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add source
          </Button>
        )}
      >
        {error ? <SettingsNote role="alert" tone="error">{error}</SettingsNote> : null}
        {loading ? <SettingsNote role="status">Loading live TV sources…</SettingsNote> : null}
        {!loading && sources.length === 0 && !error ? <SettingsNote>No live TV sources yet. Add an M3U playlist to get started.</SettingsNote> : null}
        {!loading && sources.map((source) => {
          const name = iptvSourceDisplayName(source.name);
          const SourceIcon = liveTvSourceIconPair(source.iconId).outline;
          const problem = source.refreshError ? 'error' : source.refreshWarning || source.skippedInsecure > 0 ? 'warning' : null;
          return (
            <SettingsDisclosure
              key={source.id}
              icon={<span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--loom-surface-3)]"><SourceIcon className="h-[18px] w-[18px]" aria-hidden="true" /></span>}
              title={name}
              description={`${source.health.verified.toLocaleString()} of ${source.channelCount.toLocaleString()} channels working · ${source.epgUrl ? `${source.programmeCount.toLocaleString()} guide entries` : 'No guide'}${source.refreshedAt > 0 ? ` · Updated ${updatedLabel(source.refreshedAt)}` : ''}`}
              summary={source.health.checking
                ? <SettingsBadge>Checking {source.health.checked.toLocaleString()}/{source.health.total.toLocaleString()}</SettingsBadge>
                : problem ? <SettingsBadge tone={problem}>{problem === 'error' ? 'Refresh failed' : source.refreshWarning ? 'Needs attention' : `${source.skippedInsecure.toLocaleString()} HTTP skipped`}</SettingsBadge> : null}
              actions={(
                <>
                  <Button type="button" variant="outline" size="icon" className="h-9 w-9" disabled={busy} aria-label={`Refresh ${name}`} title="Refresh" onClick={() => { void refreshSource(source.id); }}>
                    <RefreshCw className={`h-4 w-4 ${refreshing === source.id ? 'animate-spin' : ''}`} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setManager({ kind: 'edit', source })}>Edit</Button>
                </>
              )}
            >
              <SettingsRow title="Playlist" description={<code className="break-all text-[11px]">{source.playlistUrl}</code>} />
              {source.epgUrl ? <SettingsRow title="Program guide" description={<code className="break-all text-[11px]">{source.epgUrl}</code>} /> : null}
              <SettingsRow
                title="Channel health"
                description={(
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    <span>{source.health.verified.toLocaleString()} working</span>
                    {source.health.failed > 0 ? <span title="Offline, blocked, or blank channels. They return if the next check succeeds.">{source.health.failed.toLocaleString()} hidden</span> : null}
                    {source.health.pending > 0 ? <span>{source.health.pending.toLocaleString()} waiting for a check</span> : null}
                    {source.skippedInsecure > 0 ? <span className="settings-status-warning inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{source.skippedInsecure.toLocaleString()} plain HTTP skipped</span> : null}
                    {source.skippedMalformed > 0 ? <span>{source.skippedMalformed.toLocaleString()} invalid or duplicate</span> : null}
                  </span>
                )}
              />
              {source.refreshWarning && !source.refreshError ? <SettingsNote tone="warning">{source.refreshWarning}</SettingsNote> : null}
              {source.refreshError ? <SettingsNote role="alert" tone="error">{source.refreshError}</SettingsNote> : null}
              <SettingsRow title="Remove source" tone="danger" description="Removes its sidebar tab, channels, and guide data.">
                <Button type="button" variant="destructive" size="sm" className="gap-1.5" disabled={busy} aria-busy={removing === source.id} onClick={() => { void removeSource(source); }}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Remove
                </Button>
              </SettingsRow>
            </SettingsDisclosure>
          );
        })}
      </SettingsGroup>

      <SettingsDialog
        open={manager !== null}
        onClose={closeManager}
        size="lg"
        title={manager === null ? 'Live TV source' : manager.kind === 'add' ? 'Add a live TV source' : `Edit ${iptvSourceDisplayName(manager.source.name)}`}
        description="Playlist URL, optional guide URL, and sidebar icon."
      >
        {manager !== null ? (
          <div className="loom-settings-page loom-settings-dialog-body min-w-0">
            <LiveTvSettingsSection
              addOnly={manager.kind === 'add'}
              onAdded={manager.kind === 'add' ? closeManager : undefined}
              editSource={manager.kind === 'edit' ? manager.source : undefined}
              onEdited={closeManager}
              onEditCancelled={closeManager}
            />
          </div>
        ) : null}
      </SettingsDialog>
    </div>
  );
}
