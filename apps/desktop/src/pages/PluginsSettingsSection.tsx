import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SettingsBadge } from '@/components/settings/SettingsLayout';
import { AlertTriangle, Check, CheckCircle2, ChevronRight, ExternalLink, KeyRound, PackagePlus, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  desktopApi,
  type ProfileSummary,
  type StremioPluginReview,
  type StremioPluginSummary,
  type StremioPluginAuditEntry,
} from '@/lib/desktopApi';
import { saveCachedSidebarPlugins } from '@/lib/stremioPluginSidebarCache';
import { queryScope } from '@/lib/queryClient';
import { loadAddonTitles, saveAddonTitle, useAddonTitles } from '@/lib/addonTitles';
import { stremioManifestInput } from '@/lib/stremioSourceNavigation';
import AddonIconPicker from '@/components/AddonIconPicker';
import AddonManagementMenu from '@/components/AddonManagementMenu';
import { loadAddonIcons, saveAddonIcon, useAddonIcons, type AddonIconId } from '@/lib/addonIcons';

const BUILT_IN_SUBTITLE_ADDON_ID = 'org.stremio.opensubtitlesv3';
const BUILT_IN_METADATA_ADDON_ID = 'com.linvo.cinemeta';

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The add-on request failed.';
  // Manifest validation names the fields it rejected; show the first few.
  const issues = 'issues' in error && Array.isArray(error.issues) ? error.issues as { path?: unknown; message?: unknown }[] : [];
  const details = issues.slice(0, 3).map(issue => `${String(issue.path || '')}: ${String(issue.message || '')}`);
  return details.length ? `${error.message} ${details.join('; ')}${issues.length > 3 ? '; …' : ''}` : error.message;
}

function stateLabel(plugin: StremioPluginSummary): string {
  if (plugin.configurationRequired && !plugin.configured) return 'Configuration required';
  if (plugin.state === 'enabled' && plugin.trusted) return 'Enabled';
  if (plugin.state === 'pending-review') return 'Review required';
  if (plugin.state === 'broken') return 'Needs review';
  return 'Disabled';
}

function hasConfigurationValue(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0;
}

export default function PluginsSettingsSection({ mode = 'all', addonId, onInstalled, footerContainer, headerContainer, embeddedReview = false, onReviewChange, onDirtyChange, closeRequested = false, onKeepEditing, onCloseConfirmed, onBusyChange }: {
  mode?: 'all' | 'install' | 'installed';
  addonId?: string;
  onInstalled?: () => void;
  footerContainer?: HTMLElement | null;
  headerContainer?: HTMLElement | null;
  embeddedReview?: boolean;
  onReviewChange?: (name: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  closeRequested?: boolean;
  onKeepEditing?: () => void;
  onCloseConfirmed?: () => void;
}) {
  const confirm = useConfirm();
  const addonIcons = useAddonIcons();
  const addonTitles = useAddonTitles();
  const [installTitle, setInstallTitle] = useState('');
  const [manifestDrafts, setManifestDrafts] = useState<Record<string, string>>({});
  const [manifestEditing, setManifestEditing] = useState<Record<string, boolean>>({});
  const [savedManifestUrls, setSavedManifestUrls] = useState<Record<string, string>>({});
  const [iconDrafts, setIconDrafts] = useState<Record<string, AddonIconId>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [closeAfterSave, setCloseAfterSave] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const inlineManage = embeddedReview && Boolean(addonId);
  const [installed, setInstalled] = useState<StremioPluginSummary[]>([]);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileAccess, setProfileAccess] = useState<Record<string, readonly string[]>>({});
  const [manifestUrl, setManifestUrl] = useState('');
  const [installIcon, setInstallIcon] = useState<AddonIconId>('default');
  const [configurationTarget, setConfigurationTarget] = useState<StremioPluginSummary | null>(null);
  const [editingManifestUrl, setEditingManifestUrl] = useState(false);
  const [review, setReview] = useState<StremioPluginReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  useLayoutEffect(() => { onReviewChange?.(review?.name || null); }, [review?.name, onReviewChange]);
  const [busyKey, setBusyKey] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [configurationValues, setConfigurationValues] = useState<Record<string, Record<string, unknown>>>({});
  const [auditByAddon, setAuditByAddon] = useState<Record<string, readonly StremioPluginAuditEntry[]>>({});
  const userInstalled = installed.filter(plugin => plugin.addonId !== BUILT_IN_METADATA_ADDON_ID
    && plugin.addonId !== BUILT_IN_SUBTITLE_ADDON_ID
    && (!addonId || plugin.addonId === addonId));
  const hasChanges = Boolean(review) || userInstalled.some(plugin => (
    (manifestDrafts[plugin.addonId] !== undefined && manifestDrafts[plugin.addonId].trim() !== (savedManifestUrls[plugin.addonId] || '').trim())
    || (iconDrafts[plugin.addonId] !== undefined && iconDrafts[plugin.addonId] !== (addonIcons[plugin.addonId] || 'default'))
    || (titleDrafts[plugin.addonId] !== undefined && titleDrafts[plugin.addonId].trim() !== (addonTitles[plugin.addonId] || plugin.name))
    || Object.keys(configurationValues[plugin.addonId] || {}).length > 0
  )) || (mode === 'install' && Boolean(manifestUrl.trim() || installTitle.trim() || installIcon !== 'default'));
  useLayoutEffect(() => { onDirtyChange?.(hasChanges); }, [hasChanges, onDirtyChange]);
  useLayoutEffect(() => { onBusyChange?.(busyKey !== null); }, [busyKey, onBusyChange]);

  const refresh = useCallback(async () => {
    const [nextInstalled, nextProfiles] = await Promise.all([
      desktopApi.listStremioPlugins(),
      mode === 'install' ? Promise.resolve([]) : desktopApi.listProfiles(),
    ]);
    if (mode === 'install') {
      setInstalled(nextInstalled);
      saveCachedSidebarPlugins(nextInstalled);
      return;
    }
    // Retire the old plugin record now that captions use the built-in provider.
    if (nextInstalled.some(plugin => plugin.addonId === BUILT_IN_SUBTITLE_ADDON_ID)) {
      await desktopApi.removeStremioAddon(BUILT_IN_SUBTITLE_ADDON_ID);
      window.dispatchEvent(new Event('loomtv:plugins-changed'));
    }
    const remainingInstalled = nextInstalled.filter(plugin => plugin.addonId !== BUILT_IN_SUBTITLE_ADDON_ID);
    const grantableProfiles = nextProfiles.filter((profile) => profile.type === 'standard' && !profile.isGuest);
    const accessEntries = await Promise.all(grantableProfiles.map(async (profile) => (
      [profile.id, await desktopApi.listStremioProfileAccess(profile.id)] as const
    )));
    const auditEntries = await Promise.all(remainingInstalled.map(async (plugin) => {
      try { return [plugin.addonId, await desktopApi.listStremioPluginAudit(plugin.addonId, 8)] as const; } catch { return [plugin.addonId, []] as const; }
    }));
    setInstalled(remainingInstalled);
    saveCachedSidebarPlugins(remainingInstalled);
    setProfiles(grantableProfiles);
    setProfileAccess(Object.fromEntries(accessEntries));
    setAuditByAddon(Object.fromEntries(auditEntries));
  }, [mode]);

  useEffect(() => {
    let mounted = true;
    void refresh()
      .catch((loadError) => { if (mounted) setError(errorMessage(loadError)); })
      .finally(() => { if (mounted) setBusyKey(null); });
    return () => { mounted = false; };
  }, [refresh]);

  const runReview = async (key: string, operation: () => Promise<StremioPluginReview>) => {
    setBusyKey(key);
    setError(null);
    try {
      const nextReview = await operation();
      if (nextReview.addonId === BUILT_IN_SUBTITLE_ADDON_ID) {
        await refresh();
        throw new Error('OpenSubtitles v3 is built into Captions and does not need a plugin.');
      }
      setManifestUrl('');
      setInstallTitle(current => inlineManage ? titleDrafts[nextReview.addonId]?.trim() || addonTitles[nextReview.addonId] || nextReview.name : key === 'manual' && !configurationTarget && current.trim()
        ? current : loadAddonTitles()[nextReview.addonId] || nextReview.name);
      if (key !== 'manual' || configurationTarget) setInstallIcon(iconDrafts[nextReview.addonId] || loadAddonIcons()[nextReview.addonId] || 'default');
      setReview(nextReview);
      setReviewConfirmed(false);
      await refresh();
    } catch (reviewError) {
      setError(errorMessage(reviewError));
    } finally {
      setBusyKey(null);
    }
  };

  const approveReview = async () => {
    if (!review || !reviewConfirmed) return;
    setBusyKey(`approve:${review.addonId}`);
    setError(null);
    try {
      const values = configurationValues[review.addonId] || {};
      if (review.configuration.length > 0 && Object.keys(values).length > 0) {
        await desktopApi.saveStremioAddonConfiguration(review.addonId, values);
      }
      saveAddonIcon(review.addonId, inlineManage ? iconDrafts[review.addonId] ?? addonIcons[review.addonId] ?? installIcon : installIcon);
      await desktopApi.approveStremioAddon(review.addonId, review.reviewToken);
      saveAddonTitle(review.addonId, inlineManage ? titleDrafts[review.addonId]?.trim() || addonTitles[review.addonId] || installTitle.trim() || review.name : installTitle.trim() || review.name);
      setManifestDrafts({});
      setManifestEditing(current => ({ ...current, [review.addonId]: false }));
      setIconDrafts({});
      setTitleDrafts({});
      setReview(null);
      setConfigurationTarget(null);
      setConfigurationValues({});
      setReviewConfirmed(false);
      setManifestUrl('');
      setInstallTitle('');
      await refresh();
      window.dispatchEvent(new Event('loomtv:plugins-changed'));
      onInstalled?.();
      if (closeAfterSave) onCloseConfirmed?.();
    } catch (approveError) {
      setError(errorMessage(approveError));
    } finally {
      setBusyKey(null);
    }
  };

  const disablePlugin = async (plugin: StremioPluginSummary) => {
    setBusyKey(`disable:${plugin.addonId}`);
    setError(null);
    try {
      await desktopApi.disableStremioAddon(plugin.addonId);
      await refresh();
      window.dispatchEvent(new Event('loomtv:plugins-changed'));
    } catch (disableError) {
      setError(errorMessage(disableError));
    } finally {
      setBusyKey(null);
    }
  };

  const removePlugin = async (plugin: StremioPluginSummary, approved = false) => {
    if (inlineManage && !approved) { setPendingRemoval(plugin.addonId); return; }
    const confirmed = approved || await confirm({
      title: `Remove ${plugin.name}?`,
      description: 'Its saved approval and profile access will be removed from this Loom host.',
      confirmLabel: 'Remove add-on',
      destructive: true,
    });
    if (!confirmed) return;
    setBusyKey(`remove:${plugin.addonId}`);
    setError(null);
    try {
      await desktopApi.removeStremioAddon(plugin.addonId);
      if (review?.addonId === plugin.addonId) setReview(null);
      await refresh();
      window.dispatchEvent(new Event('loomtv:plugins-changed'));
      if (inlineManage) onCloseConfirmed?.();
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBusyKey(null);
    }
  };

  const updateProfileAccess = async (profile: ProfileSummary, plugin: StremioPluginSummary, enabled: boolean) => {
    const key = `profile:${profile.id}:${plugin.addonId}`;
    setBusyKey(key);
    setError(null);
    try {
      await desktopApi.setStremioProfileAccess(profile.id, plugin.addonId, enabled);
      setProfileAccess((current) => ({
        ...current,
        [profile.id]: enabled
          ? [...new Set([...(current[profile.id] || []), plugin.addonId])]
          : (current[profile.id] || []).filter((addonId) => addonId !== plugin.addonId),
      }));
    } catch (accessError) {
      setError(errorMessage(accessError));
    } finally {
      setBusyKey(null);
    }
  };

  const saveConfiguration = async (plugin: StremioPluginSummary) => {
    const key = `config:${plugin.addonId}`;
    setBusyKey(key);
    setError(null);
    try {
      await desktopApi.saveStremioAddonConfiguration(plugin.addonId, configurationValues[plugin.addonId] || {});
      setConfigurationValues((current) => {
        const next = { ...current };
        delete next[plugin.addonId];
        return next;
      });
      await refresh();
    } catch (configurationError) {
      setError(errorMessage(configurationError));
    } finally {
      setBusyKey(null);
    }
  };

  const setConfigurationValue = (pluginId: string, fieldKey: string, value: unknown) => {
    setConfigurationValues((current) => ({
      ...current,
      [pluginId]: { ...(current[pluginId] || {}), [fieldKey]: value },
    }));
  };

  const editManifestUrl = async (plugin: StremioPluginSummary) => {
    if (manifestDrafts[plugin.addonId] !== undefined && savedManifestUrls[plugin.addonId]) {
      setManifestEditing(current => ({ ...current, [plugin.addonId]: true }));
      requestAnimationFrame(() => document.getElementById(`manifest-${plugin.addonId}`)?.focus());
      return;
    }
    const scope = JSON.stringify(queryScope());
    setBusyKey(`edit-url:${plugin.addonId}`);
    setError(null);
    try {
      const url = await desktopApi.getStremioManifestUrl(plugin.addonId, plugin.revision);
      if (scope !== JSON.stringify(queryScope())) return;
      if (!url.trim()) throw new Error('The saved URL could not be loaded. Reopen Manage and try again.');
      setSavedManifestUrls(current => ({ ...current, [plugin.addonId]: url }));
      setManifestDrafts(current => ({ ...current, [plugin.addonId]: url }));
      setManifestEditing(current => ({ ...current, [plugin.addonId]: true }));
      requestAnimationFrame(() => document.getElementById(`manifest-${plugin.addonId}`)?.focus());
    } catch (cause) {
      if (scope === JSON.stringify(queryScope())) {
        setManifestEditing(current => ({ ...current, [plugin.addonId]: false }));
        setError(errorMessage(cause));
      }
    } finally {
      if (scope === JSON.stringify(queryScope())) setBusyKey(null);
    }
  };

  const openConfiguration = async (plugin: StremioPluginSummary) => {
    setBusyKey(`browser-config:${plugin.addonId}`);
    setError(null);
    try {
      await desktopApi.openStremioConfiguration(plugin.addonId, plugin.revision);
      setEditingManifestUrl(false);
      setConfigurationTarget(plugin);
      setManifestUrl('');
      setReview(null);
      setReviewConfirmed(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusyKey(null); }
  };

  const reviewConfigurationComplete = !review || review.configured
    || (review.configuration.length > 0 && review.configuration.every(field => (
      !field.required || hasConfigurationValue(configurationValues[review.addonId]?.[field.key])
    )));

  async function saveChanges(closeAfter = false) {
    setCloseAfterSave(closeAfter);
    onKeepEditing?.();
    const plugin = userInstalled[0];
    if (mode === 'install') {
      if (manifestUrl.trim()) await runReview('manual', () => desktopApi.reviewStremioManifestUrl(stremioManifestInput(manifestUrl.trim())));
      return;
    }
    if (!plugin) return;
    const url = manifestDrafts[plugin.addonId]?.trim();
    if (url && url !== savedManifestUrls[plugin.addonId]) {
      await runReview(`url:${plugin.addonId}`, () => desktopApi.reviewStremioManifestUrl(stremioManifestInput(url), plugin.addonId));
      return;
    }
    if (plugin.state !== 'enabled' || !plugin.trusted) {
      await runReview(`enable:${plugin.addonId}`, () => desktopApi.reviewInstalledStremioAddon(plugin.addonId));
      return;
    }
    setBusyKey('save-changes');
    setError(null);
    try {
      if (Object.keys(configurationValues[plugin.addonId] || {}).length) {
        await desktopApi.saveStremioAddonConfiguration(plugin.addonId, configurationValues[plugin.addonId]);
      }
      if (titleDrafts[plugin.addonId] !== undefined) saveAddonTitle(plugin.addonId, titleDrafts[plugin.addonId]);
      if (iconDrafts[plugin.addonId] !== undefined) saveAddonIcon(plugin.addonId, iconDrafts[plugin.addonId]);
      setIconDrafts({}); setTitleDrafts({}); setConfigurationValues({});
      setManifestDrafts({}); setManifestEditing({});
      await refresh();
      if (closeAfter) onCloseConfirmed?.();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusyKey(null); }
  }

  const closeActions = (
    <div className="w-full space-y-3">
      <p role="alert" className="text-sm text-[var(--loom-text)]">You have unsaved changes. Save them before closing?</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busyKey !== null} onClick={onKeepEditing}>Keep editing</Button>
        <Button variant="outline" disabled={busyKey !== null} onClick={onCloseConfirmed}>Discard changes</Button>
        <Button disabled={busyKey !== null} onClick={() => { if (review) { setCloseAfterSave(true); onKeepEditing?.(); } else void saveChanges(true); }}>{review ? 'Review changes' : 'Save & close'}</Button>
      </div>
    </div>
  );
  const manifestSubmit = closeRequested ? closeActions : (
    <Button type="submit" form="stremio-manifest-form" disabled={busyKey !== null || !manifestUrl.trim()}>
      {busyKey === 'manual' ? 'Reviewing…' : 'Review manifest'}
    </Button>
  );
  const manifestForm = (
    <div className="space-y-4">
    <form
      id="stremio-manifest-form"
      className={!configurationTarget ? 'grid w-full min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]' : 'flex flex-col gap-3 sm:flex-row'}
      onSubmit={(event) => {
        event.preventDefault();
        const url = manifestUrl.trim();
        if (!url) return;
        void runReview('manual', () => desktopApi.reviewStremioManifestUrl(stremioManifestInput(url), configurationTarget?.addonId));
      }}
    >
      {!configurationTarget ? (
        <input type="text" aria-label="Tab name" value={installTitle} onChange={event => setInstallTitle(event.target.value)} maxLength={120}
          disabled={busyKey !== null} placeholder="Tab name"
          className="h-10 w-full min-w-0 rounded-[10px] border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]" />
      ) : null}
      <input
        id="stremio-manifest-url"
        aria-label="Manifest URL"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        required
        value={manifestUrl}
        onChange={(event) => setManifestUrl(event.target.value)}
        placeholder="https://provider.example/manifest.json"
        className="h-10 min-w-0 flex-1 rounded-[10px] border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-white outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
      />
      {embeddedReview && footerContainer ? createPortal(<div className="flex w-full justify-end">{manifestSubmit}</div>, footerContainer) : manifestSubmit}
    </form>
    {!configurationTarget ? <AddonIconPicker value={installIcon} onChange={setInstallIcon} disabled={busyKey !== null} /> : null}
    </div>
  );

  const pluginHeading = (plugin: StremioPluginSummary) => (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <p className="font-semibold text-[var(--loom-text)]">{addonTitles[plugin.addonId] || plugin.name}</p>
      <SettingsBadge tone={stateLabel(plugin) === 'Enabled' ? 'ok' : stateLabel(plugin) === 'Disabled' ? 'muted' : 'warning'}>{stateLabel(plugin)}</SettingsBadge>
      <span className="text-xs text-[var(--loom-faint)]">v{plugin.version}</span>
    </div>
  );

  const pluginActions = (plugin: StremioPluginSummary) => (
    <div className="flex w-full flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-2">
                  {inlineManage ? <AddonManagementMenu disabled={busyKey !== null}
                    onDisable={plugin.state === 'enabled' ? () => { void disablePlugin(plugin); } : undefined}
                    onRemove={() => { void removePlugin(plugin); }} /> : null}
                  {!inlineManage && plugin.state === 'enabled' && (
                    <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void disablePlugin(plugin)}>
                      {busyKey === `disable:${plugin.addonId}` ? 'Disabling…' : 'Disable'}
                    </Button>
                  )}
                  {!inlineManage && plugin.state !== 'enabled' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyKey !== null}
                      onClick={() => void runReview(
                        `enable:${plugin.addonId}`,
                        () => desktopApi.reviewInstalledStremioAddon(plugin.addonId),
                      )}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {busyKey === `enable:${plugin.addonId}`
                        ? 'Reviewing…'
                        : plugin.state === 'disabled' ? 'Enable' : 'Review again'}
                    </Button>
                  )}
                  {!inlineManage ? <Button size="sm" variant="destructive" disabled={busyKey !== null} onClick={() => void removePlugin(plugin)}>
                    <Trash2 className="mr-2 h-4 w-4" /> Remove
                  </Button> : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
                      {inlineManage && plugin.configurable ? <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void openConfiguration(plugin)} className="gap-2"><ExternalLink aria-hidden="true" className="h-4 w-4" />Configure</Button> : null}
{!inlineManage && plugin.configuration.length > 0 ? <Button size="sm" variant="outline" disabled={busyKey !== null || plugin.state === 'disabled'} onClick={() => void saveConfiguration(plugin)}>
                        {busyKey === `config:${plugin.addonId}` ? 'Saving…' : plugin.configured ? 'Update configuration' : 'Save configuration'}
                      </Button> : null}
                      {!inlineManage && plugin.configurable ? <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void openConfiguration(plugin)} className="gap-2"><ExternalLink className="h-4 w-4" />Configure in browser</Button> : null}
                      {inlineManage ? <Button size="sm" disabled={busyKey !== null || (titleDrafts[plugin.addonId] !== undefined && !titleDrafts[plugin.addonId].trim())} onClick={() => { if (!hasChanges && plugin.state === 'enabled' && plugin.trusted) onCloseConfirmed?.(); else void saveChanges(); }}>
                        {busyKey?.startsWith('enable:') || busyKey?.startsWith('url:') ? 'Reviewing…' : hasChanges ? 'Review & save' : plugin.state === 'disabled' ? 'Enable' : plugin.state !== 'enabled' || !plugin.trusted ? 'Review & enable' : 'Done'}
                      </Button> : null}
      </div>
                </div>
  );

  const removalActions = (plugin: StremioPluginSummary) => (
    <div className="w-full space-y-3">
      <p role="alert" className="text-sm text-[var(--loom-text)]">Remove {addonTitles[plugin.addonId] || plugin.name}? Its approval and profile access will be removed.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busyKey !== null} onClick={() => setPendingRemoval(null)}>Cancel</Button>
        <Button variant="destructive" disabled={busyKey !== null} onClick={() => void removePlugin(plugin, true)}>Remove add-on</Button>
      </div>
    </div>
  );

  const reviewActions = closeRequested ? closeActions : (
              <div className="flex w-full items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => { setReview(null); setCloseAfterSave(false); }} disabled={busyKey !== null}>Keep editing</Button>
                <Button onClick={() => void approveReview()} disabled={!reviewConfirmed || !reviewConfigurationComplete || busyKey !== null}>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {busyKey === `approve:${review?.addonId}` ? 'Enabling…' : 'Approve & enable'}
                </Button>
              </div>
  );

  const reviewContent = (
        <DialogContent className={embeddedReview ? 'space-y-4' : 'space-y-4 p-6'}>
          {error ? <p role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
          {!embeddedReview ? <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <ShieldCheck className="h-4 w-4 text-[var(--loom-accent)]" />
              Approval review: {review?.name}
            </DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">
              {review ? `Version ${review.version} from ${review.manifestOrigin}. Approval applies only to this reviewed manifest revision.` : ''}
            </DialogDescription>
          </DialogHeader> : <p className="text-xs leading-5 text-[var(--loom-muted)]">{review ? `Version ${review.version} from ${review.manifestOrigin}. Approval applies only to this reviewed manifest revision.` : ''}</p>}
          {review && (
            <div className="space-y-4 text-sm">
              {!inlineManage ? <>
              <label className="block space-y-2 text-xs font-medium text-[var(--loom-text)]">
                <span>Title</span>
                <input type="text" value={installTitle} onChange={event => setInstallTitle(event.target.value)} maxLength={120}
                  disabled={busyKey !== null} placeholder={review.name}
                  className="h-10 w-full rounded-[10px] border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]" />
              </label>
              <AddonIconPicker value={installIcon} onChange={setInstallIcon} disabled={busyKey !== null} />
              </> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <ReviewField label="Resources" value={review.resources.join(', ') || 'None'} />
                <ReviewField label="Media types" value={review.types.join(', ') || 'None'} />
                <ReviewField label="Catalogs" value={review.catalogs.map(({ name, type }) => `${name} (${type})`).join(', ') || 'None'} />
                <ReviewField label="Endpoint" value={review.manifestUrlRedacted} />
              </div>
              {review.warnings.length > 0 && (
                <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-yellow-100">
                  <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> Review warnings</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5">
                    {review.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-xs leading-5 text-[var(--loom-muted)]">This provider can see your IP address and requests, including titles you search for.</p>
              {review.configurable ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--loom-border)] p-3">
                  <p className="min-w-0 flex-1 text-xs text-[var(--loom-muted)]">Configure on the provider website, then paste its manifest link back into LoomTV for review.</p>
                  <Button variant="outline" size="sm" disabled={busyKey !== null} onClick={() => void openConfiguration(review)} className="gap-1.5"><ExternalLink className="h-3.5 w-3.5" />Configure in browser</Button>
                </div>
              ) : null}
              {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
              {review.configuration.length > 0 && !review.configured && (
                <div className="rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                  <p className="flex items-center gap-2 font-medium text-white">
                    <KeyRound className="h-4 w-4 text-[var(--loom-accent)]" />
                    Add-on configuration
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {review.configuration.map((field) => {
                      const value = configurationValues[review.addonId]?.[field.key];
                      const label = field.title || field.key;
                      if (field.type === 'checkbox' || field.type === 'boolean') {
                        return (
                          <label key={field.key} className="flex min-h-9 items-center gap-2 text-xs text-[var(--loom-muted)]">
                            <input
                              type="checkbox"
                              checked={value === true}
                              onChange={(event) => setConfigurationValue(review.addonId, field.key, event.target.checked)}
                              className="h-4 w-4 accent-[var(--loom-accent)]"
                            />
                            {label}{field.required ? ' *' : ''}
                          </label>
                        );
                      }
                      if (field.type === 'select' && field.options?.length) {
                        return (
                          <label key={field.key} className="grid gap-1 text-xs text-[var(--loom-muted)]">
                            <span>{label}{field.required ? ' *' : ''}</span>
                            <select
                              value={typeof value === 'string' ? value : ''}
                              onChange={(event) => setConfigurationValue(review.addonId, field.key, event.target.value)}
                              className="h-9 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-2 text-sm text-white"
                            >
                              <option value="">Select…</option>
                              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                          </label>
                        );
                      }
                      return (
                        <label key={field.key} className="grid gap-1 text-xs text-[var(--loom-muted)]">
                          <span>{label}{field.required ? ' *' : ''}</span>
                          <input
                            type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                            value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                            onChange={(event) => setConfigurationValue(review.addonId, field.key, event.target.value)}
                            className="h-9 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-2 text-sm text-white outline-none focus:border-[var(--loom-accent)]"
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <label className="flex items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3 text-[var(--loom-muted)]">
                <input
                  type="checkbox"
                  checked={reviewConfirmed}
                  onChange={(event) => setReviewConfirmed(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--loom-accent)]"
                />
                <span>I understand this add-on is a remote third-party service and approve Loom contacting the reviewed origin.</span>
              </label>
              {embeddedReview && footerContainer ? createPortal(reviewActions, footerContainer) : reviewActions}
            </div>
          )}
        </DialogContent>
  );

  if (embeddedReview && review) return reviewContent;

  return (
    <div className={mode === 'install' ? 'w-full min-w-0 space-y-2' : 'space-y-4'}>
      {headerContainer && addonId && userInstalled[0] ? createPortal(pluginHeading(userInstalled[0]), headerContainer) : null}
      {!embeddedReview ? (
      <Dialog
        open={Boolean(review)}
        contentClassName="max-w-[min(92vw,48rem)] border border-[var(--loom-border)] bg-[var(--loom-surface)] p-0 text-[var(--loom-text)] shadow-2xl"
        onOpenChange={(open) => {
          if (open) return;
          setReview(null);
          setReviewConfirmed(false);
        }}
      >
        {reviewContent}

      </Dialog>
      ) : null}

      {error && (!review || inlineManage) && (
        <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {configurationTarget && !inlineManage ? (
        <div className="space-y-4 pr-10">
          <p className="text-sm font-semibold text-[var(--loom-text)]">{editingManifestUrl ? 'Edit URL for' : 'Configure'} {configurationTarget.name}</p>
          <p className="text-xs leading-5 text-[var(--loom-muted)]">{editingManifestUrl ? 'Paste the complete manifest URL to replace the saved link. Review and approve it to save your changes.' : 'Choose your settings on the provider website, then paste its manifest link below to review and save the update.'}</p>
          {manifestForm}
          <Button variant="ghost" size="sm" onClick={() => { setConfigurationTarget(null); setManifestUrl(''); setEditingManifestUrl(false); }}>Cancel</Button>
        </div>
      ) : mode === 'install' ? (
        <div className="w-full min-w-0">{manifestForm}</div>
      ) : mode !== 'installed' ? (
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <PackagePlus className="h-4 w-4 text-[var(--loom-accent)]" />
              Add by manifest URL
            </CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Paste an add-on's manifest link (https:// or stremio://). The Archive.org listing link also works. Catalog and stream sources appear in the sidebar after approval.
            </CardDescription>
          </CardHeader>
          <CardContent>{manifestForm}</CardContent>
        </Card>
      ) : null}

      {mode !== 'install' && (!configurationTarget || inlineManage) && <Card className={mode === 'installed' ? 'border-0 bg-transparent shadow-none' : 'settings-panel'}>
        {mode !== 'installed' && <CardHeader>
          <CardTitle className="text-white">Installed add-ons</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Owners can use enabled add-ons. Choose access for each standard profile below.
          </CardDescription>
        </CardHeader>}
        <CardContent className={mode === 'installed' ? 'space-y-3 p-0' : 'space-y-3'}>
          {busyKey === 'load' && <p className="text-sm text-[var(--loom-muted)]">Loading add-ons…</p>}
          {busyKey !== 'load' && userInstalled.length === 0 && (
            <p className="text-sm text-[var(--loom-muted)]">No add-ons installed yet.</p>
          )}
          {userInstalled.map((plugin) => (
            <div key={plugin.addonId} className={addonId ? 'space-y-4' : 'space-y-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-4'}>
              <div className="min-w-0 flex-1">
                {!headerContainer || !addonId ? pluginHeading(plugin) : null}
                <div className={inlineManage ? 'grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]' : ''}>
                {inlineManage ? <input type="text" aria-label="Tab name" placeholder="Tab name" maxLength={120} value={titleDrafts[plugin.addonId] ?? addonTitles[plugin.addonId] ?? plugin.name}
                    disabled={busyKey !== null} onChange={event => setTitleDrafts(current => ({ ...current, [plugin.addonId]: event.target.value }))}
                    className="h-9 w-full rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]" />
                 : null}
                <div className={inlineManage ? 'min-w-0' : 'mt-4'}>
                  <div className="settings-key-row flex items-center gap-1.5">
                  <input
                    id={`manifest-${plugin.addonId}`}
                    aria-label="Manifest URL"
                    type="text" inputMode="url" autoComplete="off" spellCheck={false}
                    value={manifestDrafts[plugin.addonId] ?? plugin.manifestUrlRedacted}
                    readOnly={!manifestEditing[plugin.addonId]}
                    placeholder="Paste the complete manifest URL"
                    onChange={(event) => { setManifestDrafts(current => ({ ...current, [plugin.addonId]: event.target.value })); setReview(null); setReviewConfirmed(false); }}
                    disabled={busyKey !== null}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setManifestEditing(current => ({ ...current, [plugin.addonId]: false }));
                        setManifestDrafts(current => {
                          const next = { ...current }; delete next[plugin.addonId]; return next;
                        });
                      }
                      if (event.key === 'Enter' && manifestEditing[plugin.addonId]) {
                        event.preventDefault();
                        const button = event.currentTarget.nextElementSibling;
                        if (button instanceof HTMLButtonElement) button.click();
                      }
                    }}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-muted)] focus:border-[var(--loom-accent)] read-only:text-[var(--loom-muted)]"
                  />
                  <Button type="button" size="icon" variant="outline" aria-label={manifestEditing[plugin.addonId] ? 'Save manifest URL' : 'Edit manifest URL'} title={manifestEditing[plugin.addonId] ? 'Save manifest URL' : 'Edit manifest URL'} className="h-9 w-9 shrink-0" disabled={busyKey !== null || Boolean(manifestEditing[plugin.addonId] && !manifestDrafts[plugin.addonId]?.trim())} onClick={() => {
                    if (!manifestEditing[plugin.addonId]) {
                      void editManifestUrl(plugin);
                      return;
                    }
                    const url = manifestDrafts[plugin.addonId]?.trim();
                    if (!url) return;
                    if (inlineManage) { setManifestEditing(current => ({ ...current, [plugin.addonId]: false })); return; }
                    setConfigurationTarget(plugin);
                    setEditingManifestUrl(true);
                    setManifestUrl(url);
                    void runReview(`url:${plugin.addonId}`, () => desktopApi.reviewStremioManifestUrl(stremioManifestInput(url), plugin.addonId));
                  }}>{manifestEditing[plugin.addonId] ? <Check aria-hidden="true" className="h-4 w-4" /> : <Pencil aria-hidden="true" className="h-4 w-4" />}</Button>
                  </div>
                </div>
                </div>
                <div className="mt-4">
                  <AddonIconPicker
                    value={iconDrafts[plugin.addonId] ?? addonIcons[plugin.addonId] ?? 'default'}
                    disabled={busyKey !== null}
                    onChange={(icon) => {
                      if (inlineManage) { setIconDrafts(current => ({ ...current, [plugin.addonId]: icon })); return; }
                      try { saveAddonIcon(plugin.addonId, icon); }
                      catch (cause) { setError(errorMessage(cause)); }
                    }}
                  />
                </div>
                <section aria-label="About" className="mt-4 space-y-2">
                  <h3 className="text-sm font-medium text-[var(--loom-text)]">About</h3>
                  <p className="whitespace-pre-line break-words text-xs leading-5 text-[var(--loom-muted)]">{plugin.description}</p>
                </section>
                {plugin.state !== 'enabled' && (
                  <p className="mt-2 text-xs text-yellow-200">{plugin.state === 'broken' ? 'Provider health failed repeatedly. Review the manifest again before enabling it.' : 'Review this provider again before enabling it.'}</p>
                )}
                {plugin.failureCount > 0 && (
                  <p className="mt-2 text-xs text-[var(--loom-faint)]">
                    {plugin.failureCount} recent provider failure{plugin.failureCount === 1 ? '' : 's'}
                    {plugin.nextRetryAt ? ` · backoff until ${new Date(plugin.nextRetryAt).toLocaleTimeString()}` : ''}
                  </p>
                )}
                {(plugin.configuration.length > 0 || plugin.configurationRequired || plugin.configurable) && (
                  <div className="mt-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-3">
                    <p className="flex items-center gap-2 text-xs font-medium text-[var(--loom-text)]"><KeyRound className="h-3.5 w-3.5" /> Configuration</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--loom-faint)]">Saved keys and configured links stay in the desktop host.</p>
                    {plugin.configuration.length > 0 ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {plugin.configuration.map((field) => {
                          const value = configurationValues[plugin.addonId]?.[field.key];
                          const label = field.title || field.key;
                          if (field.type === 'checkbox' || field.type === 'boolean') {
                            return (
                              <label key={field.key} className="flex min-h-9 items-center gap-2 text-xs text-[var(--loom-muted)]">
                                <input
                                  type="checkbox"
                                  checked={value === true}
                                  onChange={(event) => setConfigurationValue(plugin.addonId, field.key, event.target.checked)}
                                  className="h-4 w-4 accent-[var(--loom-accent)]"
                                />
                                {label}{field.required ? ' *' : ''}
                              </label>
                            );
                          }
                          if (field.type === 'select' && field.options?.length) {
                            return (
                              <label key={field.key} className="grid gap-1 text-xs text-[var(--loom-muted)]">
                                <span>{label}{field.required ? ' *' : ''}</span>
                                <select
                                  value={typeof value === 'string' ? value : ''}
                                  onChange={(event) => setConfigurationValue(plugin.addonId, field.key, event.target.value)}
                                  className="h-9 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-2 text-sm text-white"
                                >
                                  <option value="">Select…</option>
                                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                                </select>
                              </label>
                            );
                          }
                          return (
                            <label key={field.key} className="grid gap-1 text-xs text-[var(--loom-muted)]">
                              <span>{label}{field.required ? ' *' : ''}</span>
                              <input
                                type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                                value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                                onChange={(event) => setConfigurationValue(plugin.addonId, field.key, field.type === 'number' ? event.target.value : event.target.value)}
                                className="h-9 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-2 text-sm text-white outline-none focus:border-[var(--loom-accent)]"
                              />
                            </label>
                          );
                        })}
                      </div>
                    ) : <p className="mt-2 text-xs text-[var(--loom-muted)]">Use the provider website, then review the manifest link it gives you.</p>}
                    <div className="mt-3 flex items-center gap-2">
                      {plugin.configured && <span className="text-xs text-emerald-300">Configured</span>}
                    </div>
                  </div>
                )}
                {(auditByAddon[plugin.addonId]?.length || 0) > 0 && (
                  <details className="group/history mt-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)]">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl p-3 text-xs font-medium text-[var(--loom-text)] hover:bg-[var(--loom-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] [&::-webkit-details-marker]:hidden">
                      <span>Host history</span>
                      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--loom-muted)] transition-transform duration-200 group-open/history:rotate-90" />
                    </summary>
                    <ul className="space-y-1 px-3 pb-3 text-xs text-[var(--loom-faint)]">
                      {auditByAddon[plugin.addonId].map((entry) => (
                        <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                          <span>{entry.eventType}</span>
                          <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plugin.state === 'enabled' && profiles.length > 0 && (
                  <fieldset className="mt-3">
                    <legend className="text-xs font-medium text-[var(--loom-faint)]">Standard profile access</legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {profiles.map((profile) => {
                        const checked = Boolean(profileAccess[profile.id]?.includes(plugin.addonId));
                        const accessKey = `profile:${profile.id}:${plugin.addonId}`;
                        return (
                          <label key={profile.id} className="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--loom-border)] px-3 text-xs text-[var(--loom-muted)]">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busyKey !== null}
                              onChange={(event) => void updateProfileAccess(profile, plugin, event.target.checked)}
                              className="h-4 w-4 accent-[var(--loom-accent)]"
                            />
                            <span>{busyKey === accessKey ? 'Saving…' : profile.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
              </div>
              {footerContainer && addonId ? createPortal(closeRequested ? closeActions : pendingRemoval === plugin.addonId ? removalActions(plugin) : inlineManage && review ? reviewActions : pluginActions(plugin), footerContainer) : pluginActions(plugin)}
            </div>
          ))}
        </CardContent>
      </Card>}
    </div>
  );
}

function ReviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--loom-surface-2)] p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">{label}</p>
      <p className="mt-1 break-words text-[var(--loom-text)]">{value}</p>
    </div>
  );
}
