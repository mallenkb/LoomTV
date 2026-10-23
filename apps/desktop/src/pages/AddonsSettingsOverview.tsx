import { useEffect, useState } from 'react';
import { Archive, Compass, Plus, Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SettingsBadge, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow, SettingsSelect } from '@/components/settings/SettingsLayout';
import { addonResolutionOptions, saveAddonSourcePreferences, useAddonSourcePreferences, type AddonSourcePreferences } from '@/lib/addonSourcePreferences';
import { desktopApi, type StremioPluginSummary } from '@/lib/desktopApi';
import { useNavigate } from '@/lib/navigation';
import { isBrowsableStremioSource } from '@/lib/stremioPluginSidebarCache';
import PluginsSettingsSection from './PluginsSettingsSection';
import { addonSourceIconPair } from '@/components/AddonSourceIcons';
import { useAddonIcons } from '@/lib/addonIcons';
import { useAddonTitles } from '@/lib/addonTitles';

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
  const navigate = useNavigate();
  const sourcePreferences = useAddonSourcePreferences();
  const addonIcons = useAddonIcons();
  const addonTitles = useAddonTitles();
  const [resolutionsOpen, setResolutionsOpen] = useState(false);
  const resolutionSummary = addonResolutionOptions.filter(option => sourcePreferences.resolutions.includes(option.value)).map(option => option.label).join(', ');
  const addonName = (addon: StremioPluginSummary) => {
    const selected = addonIcons[addon.addonId];
    const Icon = selected && selected !== 'default' ? addonSourceIconPair(selected).outline : addon.addonId === 'org.archive.clean' ? Archive : Compass;
    return <span className="inline-flex min-w-0 items-center gap-2"><Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{addonTitles[addon.addonId] || addon.name.replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Add-on'}</span></span>;
  };
  const [preferenceError, setPreferenceError] = useState('');
  const saveSourcePreference = (change: Partial<AddonSourcePreferences>) => {
    try { saveAddonSourcePreferences(change); setPreferenceError(''); }
    catch { setPreferenceError('Could not save your streaming preferences on this device.'); }
  };
  const [addons, setAddons] = useState<StremioPluginSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [managerFooter, setManagerFooter] = useState<HTMLDivElement | null>(null);
  const [managerHeader, setManagerHeader] = useState<HTMLDivElement | null>(null);
  const [manager, setManager] = useState<Manager | null>(null);
  const [reviewTitle, setReviewTitle] = useState<string | null>(null);
  const [managerDirty, setManagerDirty] = useState(false);
  const [managerBusy, setManagerBusy] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);

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

  const finishCloseManager = () => {
    setManager(null);
    setReviewTitle(null);
    setManagerDirty(false);
    setManagerBusy(false);
    setCloseRequested(false);
    setRevision((value) => value + 1);
  };
  const closeManager = () => {
    if (managerBusy) return;
    if (managerDirty) { setCloseRequested(true); return; }
    finishCloseManager();
  };
  const warningCount = addons.reduce((count, addon) => count + addon.warnings.length, 0);

  return (
    <div>
      <SettingsPageHeader title="Add-ons" description="Stremio add-ons for catalogs, playback sources, metadata, and subtitles." />

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
          const hasCatalog = addon.catalogs.length > 0 || addon.addonId === 'org.archive.clean';
          const hasStreams = addon.resources.includes('stream');
          const canBrowse = isBrowsableStremioSource({ ...addon, catalogCount: addon.catalogs.length });
          const capabilities = [
            ...(hasCatalog ? ['Catalogs'] : []),
            ...(hasStreams ? ['Streams'] : []),
            ...(addon.resources.includes('meta') ? ['Metadata'] : []),
            ...(addon.resources.includes('subtitles') ? ['Subtitles'] : []),
            ...(addon.resources.includes('addon_catalog') ? ['Add-on directory'] : []),
          ];
          const locationHint = hasCatalog
            ? hasStreams ? 'Browse its catalog in the sidebar and choose sources on a title or episode.' : 'Browse its catalog in the sidebar.'
            : hasStreams ? 'Open its sidebar page to browse titles and choose playback sources.'
              : addon.resources.includes('subtitles') ? 'Available in the player when choosing subtitles.'
                : addon.resources.includes('meta') ? 'Provides details for matching titles.' : '';
          return (
            <SettingsRow
              key={addon.addonId}
              title={(
                <span className="flex flex-wrap items-center gap-2">
                  {addonName(addon)}
                  <SettingsBadge tone={status.tone}>{status.label}</SettingsBadge>
                  {capabilities.map(capability => <SettingsBadge key={capability}>{capability}</SettingsBadge>)}
                </span>
              )}
              description={(
                <>
                  {locationHint ? <p>{locationHint}</p> : null}
                  {addon.description ? <p className="mt-1 line-clamp-2 text-[var(--loom-faint)]" title={addon.description}>{addon.description}</p> : null}
                </>
              )}
            >
              {canBrowse ? (
                <Button type="button" variant="outline" size="sm" onClick={() => navigate(`/addons/stremio/${encodeURIComponent(addon.addonId)}`)}>{hasCatalog ? 'Browse catalog' : 'Open add-on'}</Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => setManager({ mode: 'installed', title: addonTitles[addon.addonId] || addon.name, description: 'Configuration, profile access, and host requests for this add-on.', addonId: addon.addonId })}>Manage</Button>
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Streaming preferences">
        <SettingsRow title="Streaming resolutions" description={resolutionSummary}>
          <Button type="button" variant="outline" size="sm" onClick={() => setResolutionsOpen(true)}>Choose resolutions</Button>
        </SettingsRow>
        <SettingsRow title="Source order" description="Suggested first favours cached or direct streams, then torrents with more reported seeders, within each add-on. Provider information is not a playback guarantee.">
          <SettingsSelect label="Add-on source order" value={sourcePreferences.suggestedFirst ? 'suggested' : 'provider'} options={[{ value: 'suggested', label: 'Suggested first' }, { value: 'provider', label: 'Provider order' }]} onChange={value => saveSourcePreference({ suggestedFirst: value === 'suggested' })} />
        </SettingsRow>
        {preferenceError ? <SettingsNote role="alert">{preferenceError}</SettingsNote> : null}
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

      <SettingsDialog open={resolutionsOpen} onClose={() => setResolutionsOpen(false)} title="Streaming resolutions"
        description="Choose one or more resolutions across all add-ons on this device. Clear your choices to show all resolutions. Unspecified includes sources without a quality label."
        footer={<Button type="button" onClick={() => setResolutionsOpen(false)}>Done</Button>}
      >
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Add-on streaming resolutions</legend>
            {addonResolutionOptions.map(option => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-surface-2)] px-3 py-2 text-sm text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--loom-accent)]"
                  checked={sourcePreferences.resolutions.includes(option.value)}
                  onChange={event => saveSourcePreference({ resolutions: option.value === 'all' ? ['all'] : event.target.checked
                    ? [...sourcePreferences.resolutions.filter(value => value !== 'all'), option.value]
                    : sourcePreferences.resolutions.filter(value => value !== option.value) })}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        {preferenceError ? <SettingsNote role="alert">{preferenceError}</SettingsNote> : null}
      </SettingsDialog>

      <SettingsDialog
        open={manager !== null}
        onClose={closeManager}
        closeOnOutsideClick={false}
        busy={managerBusy}
        size="lg"
        title={reviewTitle ? `Review ${reviewTitle}` : manager?.title ?? 'Add-ons'}
        hideHeader={!reviewTitle && manager?.mode === 'installed'}
        headerContent={!reviewTitle && manager?.mode === 'installed' ? <div ref={setManagerHeader} /> : undefined}
        fullWidthFooter
        description={reviewTitle ? 'Review the add-on details before saving.' : manager?.description}
        footer={manager !== null ? <div className="w-full" ref={setManagerFooter} /> : undefined}
      >
        {manager !== null ? (
          <div className="loom-settings-dialog-body min-w-0 space-y-4">
            <PluginsSettingsSection embeddedReview onReviewChange={setReviewTitle} onDirtyChange={setManagerDirty} onBusyChange={setManagerBusy}
              closeRequested={closeRequested} onKeepEditing={() => setCloseRequested(false)} onCloseConfirmed={finishCloseManager}
              headerContainer={managerHeader} footerContainer={managerFooter} mode={manager.mode} addonId={manager.addonId} onInstalled={manager.mode === 'install' ? finishCloseManager : undefined} />
          </div>
        ) : null}
      </SettingsDialog>
    </div>
  );
}
