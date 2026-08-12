import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, PackagePlus, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  desktopApi,
  type OfficialStremioAddon,
  type ProfileSummary,
  type StremioPluginReview,
  type StremioPluginSummary,
} from '@/lib/desktopApi';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The add-on request failed.';
}

function stateLabel(plugin: StremioPluginSummary): string {
  if (plugin.state === 'enabled' && plugin.trusted) return 'Enabled';
  if (plugin.state === 'pending-review') return 'Review required';
  return 'Disabled';
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
    setInstalled(nextInstalled);
    setOfficial(nextOfficial);
    setProfiles(grantableProfiles);
    setProfileAccess(Object.fromEntries(accessEntries));
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
      await desktopApi.approveStremioAddon(review.addonId, review.reviewToken);
      setReview(null);
      setReviewConfirmed(false);
      setManifestUrl('');
      await refresh();
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

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

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

      {review && (
        <Card className="settings-panel border-[var(--loom-accent)]/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <ShieldCheck className="h-4 w-4 text-[var(--loom-accent)]" />
              Approval review: {review.name}
            </CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Version {review.version} from {review.manifestOrigin}. Approval applies only to this reviewed manifest revision.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
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
            <label className="flex items-start gap-3 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3 text-[var(--loom-muted)]">
              <input
                type="checkbox"
                checked={reviewConfirmed}
                onChange={(event) => setReviewConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--loom-accent)]"
              />
              <span>I understand this add-on is a remote third-party service and approve LoomTV contacting the reviewed origin.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setReview(null)} disabled={busyKey !== null}>Cancel</Button>
              <Button onClick={() => void approveReview()} disabled={!reviewConfirmed || busyKey !== null}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {busyKey === `approve:${review.addonId}` ? 'Enabling…' : 'Approve & enable'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
                  <p className="mt-2 text-xs text-yellow-200">Review this provider again before enabling it.</p>
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
