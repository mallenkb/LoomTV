import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, PackagePlus, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  desktopApi,
  type OfficialStremioAddon,
  type ProfileSummary,
  type StremioPluginReview,
  type StremioPluginSummary,
  type StremioPluginAuditEntry,
} from '@/lib/desktopApi';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The add-on request failed.';
}

function stateLabel(plugin: StremioPluginSummary): string {
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

export default function PluginsSettingsSection() {
  const confirm = useConfirm();
  const [installed, setInstalled] = useState<StremioPluginSummary[]>([]);
  const [official, setOfficial] = useState<OfficialStremioAddon[]>([]);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileAccess, setProfileAccess] = useState<Record<string, readonly string[]>>({});
  const [manifestUrl, setManifestUrl] = useState('');
  const [review, setReview] = useState<StremioPluginReview | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [configurationValues, setConfigurationValues] = useState<Record<string, Record<string, unknown>>>({});
  const [auditByAddon, setAuditByAddon] = useState<Record<string, readonly StremioPluginAuditEntry[]>>({});

  const refresh = useCallback(async () => {
    const [nextInstalled, nextOfficial, nextProfiles] = await Promise.all([
      desktopApi.listStremioPlugins(),
      desktopApi.listOfficialStremioAddons(),
      desktopApi.listProfiles(),
    ]);
    const grantableProfiles = nextProfiles.filter((profile) => profile.type === 'standard' && !profile.isGuest);
    const accessEntries = await Promise.all(grantableProfiles.map(async (profile) => (
      [profile.id, await desktopApi.listStremioProfileAccess(profile.id)] as const
    )));
    const auditEntries = await Promise.all(nextInstalled.map(async (plugin) => {
      try { return [plugin.addonId, await desktopApi.listStremioPluginAudit(plugin.addonId, 8)] as const; } catch { return [plugin.addonId, []] as const; }
    }));
    setInstalled(nextInstalled);
    setOfficial(nextOfficial);
    setProfiles(grantableProfiles);
    setProfileAccess(Object.fromEntries(accessEntries));
    setAuditByAddon(Object.fromEntries(auditEntries));
  }, []);

  useEffect(() => {
    let mounted = true;
    void refresh()
      .catch((loadError) => { if (mounted) setError(errorMessage(loadError)); })
      .finally(() => { if (mounted) setBusyKey(null); });
    return () => { mounted = false; };
  }, [refresh]);

  const installedById = useMemo(
    () => new Map(installed.map((plugin) => [plugin.addonId, plugin])),
    [installed],
  );

  const runReview = async (key: string, operation: () => Promise<StremioPluginReview>) => {
    setBusyKey(key);
    setError(null);
    try {
      const nextReview = await operation();
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
      await desktopApi.approveStremioAddon(review.addonId, review.reviewToken);
      setReview(null);
      setReviewConfirmed(false);
      setManifestUrl('');
      await refresh();
      window.dispatchEvent(new Event('loomtv:plugins-changed'));
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

  const removePlugin = async (plugin: StremioPluginSummary) => {
    const confirmed = await confirm({
      title: `Remove ${plugin.name}?`,
      description: 'Its saved approval and profile access will be removed from this LoomTV host.',
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

  const reviewConfigurationComplete = !review
    || review.configured
    || review.configuration.every((field) => (
      !field.required || hasConfigurationValue(configurationValues[review.addonId]?.[field.key])
    ));

  return (
    <div className="space-y-4">
      <Dialog
        open={Boolean(review)}
        contentClassName="max-w-[min(92vw,48rem)] border border-[var(--loom-border)] bg-[var(--loom-surface)] p-0 text-[var(--loom-text)] shadow-2xl"
        onOpenChange={(open) => {
          if (open) return;
          setReview(null);
          setReviewConfirmed(false);
        }}
      >
        <DialogContent className="space-y-4 p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <ShieldCheck className="h-4 w-4 text-[var(--loom-accent)]" />
              Approval review: {review?.name}
            </DialogTitle>
            <DialogDescription className="text-[var(--loom-muted)]">
              {review ? `Version ${review.version} from ${review.manifestOrigin}. Approval applies only to this reviewed manifest revision.` : ''}
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="space-y-4 text-sm">
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
                <span>I understand this add-on is a remote third-party service and approve LoomTV contacting the reviewed origin.</span>
              </label>
              <div className="flex gap-2 sm:justify-end">
                <Button variant="ghost" onClick={() => setReview(null)} disabled={busyKey !== null}>Cancel</Button>
                <Button onClick={() => void approveReview()} disabled={!reviewConfirmed || !reviewConfigurationComplete || busyKey !== null}>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {busyKey === `approve:${review.addonId}` ? 'Enabling…' : 'Approve & enable'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <PackagePlus className="h-4 w-4 text-[var(--loom-accent)]" />
            Add by manifest URL
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Advanced: enter a remote HTTPS Stremio manifest. Local addresses, HTTP, IPFS, and executable packages are rejected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              const url = manifestUrl.trim();
              if (!url) return;
              void runReview('manual', () => desktopApi.reviewStremioManifestUrl(url));
            }}
          >
            <label className="sr-only" htmlFor="stremio-manifest-url">Stremio manifest URL</label>
            <input
              id="stremio-manifest-url"
              type="url"
              inputMode="url"
              required
              pattern="https://.*"
              value={manifestUrl}
              onChange={(event) => setManifestUrl(event.target.value)}
              placeholder="https://provider.example/manifest.json"
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-control-bg)] px-3 text-sm text-white outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
            />
            <Button type="submit" disabled={busyKey !== null || !manifestUrl.trim()}>
              {busyKey === 'manual' ? 'Reviewing…' : 'Review manifest'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <Plug className="h-4 w-4 text-[var(--loom-accent)]" />
            Official Stremio add-ons
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Review and approve remote HTTPS providers before LoomTV can contact their catalog, metadata, or subtitle endpoints.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {busyKey === 'load' && <p className="text-sm text-[var(--loom-muted)]">Loading add-ons…</p>}
          {official.map((addon) => {
            const installedPlugin = installedById.get(addon.addonId);
            return (
              <div key={addon.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-white">{addon.name}</p>
                    <span className="rounded-full bg-[var(--loom-accent)]/15 px-2 py-0.5 text-xs text-[var(--loom-accent)]">Official</span>
                    {installedPlugin && <span className="text-xs text-[var(--loom-faint)]">{stateLabel(installedPlugin)}</span>}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--loom-muted)]">{addon.description}</p>
                </div>
                <Button
                  size="sm"
                  variant={installedPlugin?.state === 'enabled' ? 'outline' : 'default'}
                  disabled={busyKey !== null}
                  onClick={() => void runReview(`official:${addon.id}`, () => desktopApi.reviewOfficialStremioAddon(addon.id))}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {busyKey === `official:${addon.id}` ? 'Reviewing…' : installedPlugin ? 'Review again' : 'Review & install'}
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white">Installed add-ons</CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Owner always has access. Grant each Standard profile explicitly; Kids and Guest profiles are always denied.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {busyKey !== 'load' && installed.length === 0 && (
            <p className="text-sm text-[var(--loom-muted)]">No add-ons installed yet.</p>
          )}
          {installed.map((plugin) => (
            <div key={plugin.addonId} className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-white">{plugin.name}</p>
                  <span className="rounded-full bg-[var(--loom-surface-3)] px-2 py-0.5 text-xs text-[var(--loom-muted)]">{stateLabel(plugin)}</span>
                  <span className="text-xs text-[var(--loom-faint)]">v{plugin.version}</span>
                </div>
                <p className="mt-1 text-sm text-[var(--loom-muted)]">{plugin.description}</p>
                <p className="mt-2 break-all text-xs text-[var(--loom-faint)]">{plugin.manifestUrlRedacted}</p>
                {plugin.state !== 'enabled' && (
                  <p className="mt-2 text-xs text-yellow-200">{plugin.state === 'broken' ? 'Provider health failed repeatedly. Review the manifest again before enabling it.' : 'Review this provider again before enabling it.'}</p>
                )}
                {plugin.failureCount > 0 && (
                  <p className="mt-2 text-xs text-[var(--loom-faint)]">
                    {plugin.failureCount} recent provider failure{plugin.failureCount === 1 ? '' : 's'}
                    {plugin.nextRetryAt ? ` · backoff until ${new Date(plugin.nextRetryAt).toLocaleTimeString()}` : ''}
                  </p>
                )}
                {(plugin.configuration.length > 0 || plugin.configurationRequired) && (
                  <div className="mt-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-3">
                    <p className="flex items-center gap-2 text-xs font-medium text-[var(--loom-text)]"><KeyRound className="h-3.5 w-3.5" /> Host configuration</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--loom-faint)]">Values are stored by the desktop host and are never returned to the renderer after saving.</p>
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
                    ) : <p className="mt-2 text-xs text-yellow-200">This provider requires configuration but did not declare host-renderable fields.</p>}
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={busyKey !== null || plugin.state === 'disabled'} onClick={() => void saveConfiguration(plugin)}>
                        {busyKey === `config:${plugin.addonId}` ? 'Saving…' : plugin.configured ? 'Update configuration' : 'Save configuration'}
                      </Button>
                      {plugin.configured && <span className="text-xs text-emerald-300">Configured</span>}
                    </div>
                  </div>
                )}
                {(auditByAddon[plugin.addonId]?.length || 0) > 0 && (
                  <details className="mt-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-3">
                    <summary className="cursor-pointer text-xs font-medium text-[var(--loom-text)]">Host history</summary>
                    <ul className="mt-2 space-y-1 text-xs text-[var(--loom-faint)]">
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
              <div className="flex gap-2">
                {plugin.state === 'enabled' && (
                  <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void disablePlugin(plugin)}>
                    {busyKey === `disable:${plugin.addonId}` ? 'Disabling…' : 'Disable'}
                  </Button>
                )}
                {plugin.state !== 'enabled' && (
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
                <Button size="sm" variant="destructive" disabled={busyKey !== null} onClick={() => void removePlugin(plugin)}>
                  <Trash2 className="mr-2 h-4 w-4" /> Remove
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
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
