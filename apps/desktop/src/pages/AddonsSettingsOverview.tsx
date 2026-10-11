import { useEffect, useState } from 'react';
import { Plus, Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SettingsBadge, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow } from '@/components/settings/SettingsLayout';
import { desktopApi, type StremioPluginSummary } from '@/lib/desktopApi';
import PluginsSettingsSection from './PluginsSettingsSection';

const BUILT_IN_ADDONS = new Set(['com.linvo.cinemeta', 'org.stremio.opensubtitlesv3']);

function addonStatus(addon: StremioPluginSummary): { label: string; tone: 'ok' | 'warning' | 'muted' } {
  if (addon.state === 'pending-review') return { label: 'Review required', tone: 'warning' };
  if (addon.state === 'broken') return { label: 'Needs review', tone: 'warning' };
  if (addon.state !== 'enabled' || !addon.trusted) return { label: 'Disabled', tone: 'muted' };
  if (addon.configurationRequired && !addon.configured) return { label: 'Needs setup', tone: 'warning' };
  return { label: 'Enabled', tone: 'ok' };
}

type Manager = { mode: 'install' | 'installed'; title: string; description: string; addonId?: string };

/** Installed add-ons at a glance. Installing, configuring, and access open the full manager. */
export default function AddonsSettingsOverview() {
  const [addons, setAddons] = useState<StremioPluginSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [manager, setManager] = useState<Manager | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      setLoading(true);
      setError(null);
      // Listing is read-only. The management panel mounts only after an
      // explicit action because it also retires built-in records.
      void desktopApi.listStremioPlugins()
        .then((next) => { if (mounted) setAddons(next.filter((addon) => !BUILT_IN_ADDONS.has(addon.addonId))); })
        .catch((cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : 'Could not load add-ons.'); })
        .finally(() => { if (mounted) setLoading(false); });
    };
    load();
    window.addEventListener('loomtv:plugins-changed', load);
    return () => {
      mounted = false;
      window.removeEventListener('loomtv:plugins-changed', load);
    };
  }, [revision]);

  const closeManager = () => {
    setManager(null);
    setRevision((value) => value + 1);
  };
  const warningCount = addons.reduce((count, addon) => count + addon.warnings.length, 0);

  return (
    <div>
      <SettingsPageHeader title="Add-ons" description="Stremio add-ons that add catalogs, metadata, and subtitles." />

      <SettingsGroup
        title="Installed add-ons"
        action={(
          <Button type="button" size="sm" className="gap-1.5" onClick={() => setManager({ mode: 'install', title: 'Install an add-on', description: 'Paste a manifest URL. You review what it can do before it installs.' })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Install add-on
          </Button>
        )}
      >
        {loading ? <SettingsNote role="status">Loading add-ons…</SettingsNote> : error ? (
          <SettingsRow title="Could not load add-ons" description={<span className="settings-status-error">{error}</span>}>
            <Button type="button" variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>Try again</Button>
          </SettingsRow>
        ) : addons.length === 0 ? (
          <div className="settings-row flex flex-col items-center justify-center gap-2 px-6 py-10 text-center" role="status">
            <span className="mb-1 grid h-11 w-11 place-items-center rounded-full bg-[var(--loom-surface-3)] text-[var(--loom-muted)]">
              <Puzzle className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-[var(--loom-text)]">No add-ons yet</p>
            <p className="max-w-xs text-xs leading-5 text-[var(--loom-muted)]">Install one to bring more catalogs and sources into Loom.</p>
          </div>
        ) : addons.map((addon) => {
          const status = addonStatus(addon);
          return (
            <SettingsRow
              key={addon.addonId}
              title={(
                <span className="flex flex-wrap items-center gap-2">
                  {addon.name}
                  <SettingsBadge tone={status.tone}>{status.label}</SettingsBadge>
                </span>
              )}
              description={addon.description ? <span className="line-clamp-2" title={addon.description}>{addon.description}</span> : undefined}
            >
              <Button type="button" variant="outline" size="sm" onClick={() => setManager({ mode: 'installed', title: addon.name, description: 'Configuration, profile access, and host requests for this add-on.', addonId: addon.addonId })}>Manage</Button>
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Access and history">
        <SettingsRow title="Profile access" description="Owner profiles can always use add-ons. Standard profiles need access per add-on.">
          <Button type="button" variant="outline" size="sm" onClick={() => setManager({ mode: 'installed', title: 'Add-on access', description: 'Choose which standard profiles can use each add-on.' })}>Manage</Button>
        </SettingsRow>
        <SettingsRow
          title="Warnings and host history"
          description={loading ? 'Loading…' : error ? 'Add-on list unavailable.' : warningCount ? `${warningCount.toLocaleString()} ${warningCount === 1 ? 'warning' : 'warnings'} from installed add-ons.` : 'No warnings from installed add-ons.'}
        >
          {warningCount ? <SettingsBadge tone="warning">{warningCount}</SettingsBadge> : null}
          <Button type="button" variant="outline" size="sm" disabled={loading || Boolean(error)} onClick={() => setManager({ mode: 'installed', title: 'Review add-ons', description: 'Approvals, configuration changes, and host requests.' })}>Review</Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsDialog
        open={manager !== null}
        onClose={closeManager}
        size="lg"
        title={manager?.title ?? 'Add-ons'}
        description={manager?.description}
        hideHeader={manager?.mode !== 'install'}
      >
        {manager !== null ? (
          <div className="loom-settings-page loom-settings-dialog-body min-w-0 space-y-4">
            <PluginsSettingsSection mode={manager.mode} addonId={manager.addonId} onInstalled={manager.mode === 'install' ? closeManager : undefined} />
          </div>
        ) : null}
      </SettingsDialog>
    </div>
  );
}
