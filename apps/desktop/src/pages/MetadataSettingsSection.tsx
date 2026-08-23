import { CheckCircle, Download, Eye, EyeOff, Key, Pencil, Plus, RefreshCw, Save, Trash2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { MetadataKeyTestResult } from '@/lib/desktopApi';
import { cn } from '@/lib/utils';
import { normalizeProviderId } from './Settings.helpers';
import type { MetadataProvider } from './Settings.types';

type MetadataSettingsSectionProps = {
  providers: MetadataProvider[];
  metadataKeys: Record<string, string>;
  metadataOfflineMode: boolean;
  editingKeys: Record<string, boolean>;
  visibleKeys: Record<string, boolean>;
  customProviders: string[];
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
  openSubtitlesLanguages: string;
  openSubtitlesAutoDownload: boolean;
  newProviderName: string;
  newProviderKey: string;
  savedKey: boolean;
  isTestingKeys: boolean;
  metadataKeyTestResults: MetadataKeyTestResult[];
  hasMetadataKeysToTest: boolean;
  setMetadataKey: (providerId: string, value: string) => void;
  setMetadataOfflineMode: (enabled: boolean) => void;
  setProviderEditing: (providerId: string, isEditing: boolean) => void;
  toggleProviderVisibility: (providerId: string) => void;
  deleteMetadataKey: (providerId: string) => void;
  setOpenSubtitlesUsername: (value: string) => void;
  setOpenSubtitlesPassword: (value: string) => void;
  setOpenSubtitlesLanguages: (value: string) => void;
  setOpenSubtitlesAutoDownload: (value: boolean) => void;
  setNewProviderName: (value: string) => void;
  setNewProviderKey: (value: string) => void;
  addMetadataKey: () => void;
  saveApiKeys: () => void;
  testApiKeys: () => void;
};

export default function MetadataSettingsSection({
  providers,
  metadataKeys,
  metadataOfflineMode,
  editingKeys,
  visibleKeys,
  customProviders,
  openSubtitlesUsername,
  openSubtitlesPassword,
  openSubtitlesLanguages,
  openSubtitlesAutoDownload,
  newProviderName,
  newProviderKey,
  savedKey,
  isTestingKeys,
  metadataKeyTestResults,
  hasMetadataKeysToTest,
  setMetadataKey,
  setMetadataOfflineMode,
  setProviderEditing,
  toggleProviderVisibility,
  deleteMetadataKey,
  setOpenSubtitlesUsername,
  setOpenSubtitlesPassword,
  setOpenSubtitlesLanguages,
  setOpenSubtitlesAutoDownload,
  setNewProviderName,
  setNewProviderKey,
  addMetadataKey,
  saveApiKeys,
  testApiKeys,
}: MetadataSettingsSectionProps) {
  return (
    <>
      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Key className="w-4 h-4 text-[var(--loom-accent)]" />
            Metadata API Keys
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Add the services you use. TVmaze and Jikan need no keys; TheTVDB is optional for TV metadata and artwork.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {providers.map((provider, providerIndex) => {
            const currentValue = metadataKeys[provider.id] || '';
            const isEditing = editingKeys[provider.id] ?? !currentValue;
            const isVisible = visibleKeys[provider.id] || false;
            const isLastBuiltInProvider = providerIndex === providers.length - 1;
            return (
              <div
                key={provider.id}
                className={cn(
                  'space-y-2 pb-5',
                  !isLastBuiltInProvider && 'border-b border-[var(--loom-border)]',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-white">{provider.label}</p>
                      {provider.badge && (
                        <span className={`text-xs px-2 py-0.5 rounded font-normal ${provider.required ? 'bg-[var(--loom-accent)]/20 text-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}>
                          {provider.badge}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-[var(--loom-muted)]">{provider.description}</p>
                  </div>
                </div>
                <div className="settings-key-row flex items-center gap-2">
                  <input
                    type={isEditing || isVisible ? 'text' : 'password'}
                    value={currentValue}
                    onChange={(event) => setMetadataKey(provider.id, event.target.value)}
                    placeholder={provider.placeholder}
                    readOnly={!isEditing}
                    className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)] read-only:text-[var(--loom-muted)]"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => toggleProviderVisibility(provider.id)}
                    disabled={!currentValue}
                    title={isVisible ? `Hide ${provider.label}` : `Show ${provider.label}`}
                    aria-label={isVisible ? `Hide ${provider.label}` : `Show ${provider.label}`}
                    className="h-10 w-10 shrink-0"
                  >
                    {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => setProviderEditing(provider.id, !isEditing)}
                    title={isEditing ? `Save ${provider.label}` : `Edit ${provider.label}`}
                    aria-label={isEditing ? `Save ${provider.label}` : `Edit ${provider.label}`}
                    className="h-10 w-10 shrink-0"
                  >
                    {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => deleteMetadataKey(provider.id)}
                    disabled={!currentValue}
                    title={`Delete ${provider.label}`}
                    aria-label={`Delete ${provider.label}`}
                    className="settings-destructive-text h-10 w-10 shrink-0 border-red-500/40 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}

          {customProviders.length > 0 && (
            <div className="space-y-3 border-t border-[var(--loom-border)] pt-5">
              <p className="text-sm font-semibold text-white">Additional Metadata Keys</p>
              {customProviders.map((providerId) => {
                const currentValue = metadataKeys[providerId] || '';
                const isEditing = editingKeys[providerId] ?? !currentValue;
                const isVisible = visibleKeys[providerId] || false;
                return (
              <div key={providerId} className="settings-key-row settings-key-row-custom flex items-center gap-2">
                    <input
                      type="text"
                      value={providerId}
                      readOnly
                      className="w-36 shrink-0 bg-[var(--loom-bg)] text-[var(--loom-muted)] border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                      type={isEditing || isVisible ? 'text' : 'password'}
                      value={currentValue}
                      onChange={(event) => setMetadataKey(providerId, event.target.value)}
                      readOnly={!isEditing}
                      placeholder="API key"
                      className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)] read-only:text-[var(--loom-muted)]"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => toggleProviderVisibility(providerId)}
                      disabled={!currentValue}
                      title={isVisible ? `Hide ${providerId}` : `Show ${providerId}`}
                      aria-label={isVisible ? `Hide ${providerId}` : `Show ${providerId}`}
                      className="h-10 w-10 shrink-0"
                    >
                      {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => setProviderEditing(providerId, !isEditing)}
                      title={isEditing ? `Save ${providerId}` : `Edit ${providerId}`}
                      aria-label={isEditing ? `Save ${providerId}` : `Edit ${providerId}`}
                      className="h-10 w-10 shrink-0"
                    >
                      {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => deleteMetadataKey(providerId)}
                      disabled={!currentValue}
                      title={`Delete ${providerId}`}
                      aria-label={`Delete ${providerId}`}
                      className="settings-destructive-text h-10 w-10 shrink-0 border-red-500/40 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-3 border-t border-[var(--loom-border)] pt-5">
            <p className="text-sm font-semibold text-white">Add New Metadata Key</p>
            <div className="settings-key-row settings-key-row-new flex items-center gap-2">
              <input
                type="text"
                value={newProviderName}
                onChange={(event) => setNewProviderName(event.target.value)}
                placeholder="Provider name, e.g. fanart"
                className="w-52 shrink-0 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
              />
              <input
                type="text"
                value={newProviderKey}
                onChange={(event) => setNewProviderKey(event.target.value)}
                placeholder="API key"
                className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={addMetadataKey}
                disabled={!normalizeProviderId(newProviderName) || !newProviderKey.trim()}
                title="Add metadata key"
                aria-label="Add metadata key"
                className="h-10 w-10 shrink-0"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--loom-accent)]" />
            OpenSubtitles (optional)
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Online subtitles are kept separate from tracks embedded in the video and subtitle files you add yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
            <input
              type="checkbox"
              checked={openSubtitlesAutoDownload}
              onChange={(event) => setOpenSubtitlesAutoDownload(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--loom-accent)]"
            />
            <span>
              <span className="block text-sm font-semibold text-white">Enable OpenSubtitles</span>
              <span className="mt-1 block text-xs text-[var(--loom-muted)]">
                Off by default. When enabled, LoomTV may download missing subtitles during scans and shows them in a separate OpenSubtitles group in the player. Embedded and added subtitle files remain available either way.
              </span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Username</span>
              <input
                type="text"
                value={openSubtitlesUsername}
                onChange={(event) => setOpenSubtitlesUsername(event.target.value)}
                placeholder="OpenSubtitles username"
                className="w-full bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Password</span>
              <input
                type="password"
                value={openSubtitlesPassword}
                onChange={(event) => setOpenSubtitlesPassword(event.target.value)}
                placeholder="OpenSubtitles password"
                className="w-full bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Languages</span>
            <input
              type="text"
              value={openSubtitlesLanguages}
              onChange={(event) => setOpenSubtitlesLanguages(event.target.value)}
              placeholder="en, es, fr"
              className="w-full bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
            />
            <span className="block text-xs text-[var(--loom-muted)]">Use comma-separated language codes. Example: en, es, fr.</span>
          </label>
        </CardContent>
      </Card>

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <WifiOff className="h-4 w-4 text-[var(--loom-accent)]" />
            Local metadata mode
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Use saved metadata and artwork without contacting providers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-start gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
            <input
              type="checkbox"
              checked={metadataOfflineMode}
              onChange={(event) => setMetadataOfflineMode(event.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--loom-accent)]"
            />
            <span>
              <span className="block text-sm font-semibold text-white">Stay offline for metadata</span>
              <span className="mt-1 block text-xs text-[var(--loom-muted)]">
                New matches and artwork stay off until you disable this.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {metadataKeyTestResults.length > 0 && (
          <div className="rounded-lg bg-[var(--loom-panel)] p-3 text-sm">
            <div className="space-y-2">
              {metadataKeyTestResults.map((result) => (
                <div key={result.provider} className="flex items-start gap-2">
                  <span className={cn(
                    'mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full',
                    result.ok ? 'bg-emerald-400' : 'bg-red-400',
                  )}
                  />
                  <p className={result.ok ? 'text-white/85' : 'settings-status-error'}>
                    <span className="font-semibold uppercase">{result.provider}</span>
                    <span className="text-[var(--loom-muted)]"> - {result.message}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={saveApiKeys} className="gap-2 w-full sm:w-auto">
            {savedKey ? <CheckCircle className="w-4 h-4" /> : <Key className="w-4 h-4" />}
            {savedKey ? 'API keys saved' : 'Save API keys'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={testApiKeys}
            disabled={isTestingKeys || !hasMetadataKeysToTest}
            className="gap-2 w-full sm:w-auto"
          >
            {isTestingKeys ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {isTestingKeys ? 'Testing API keys...' : 'Test API keys'}
          </Button>
        </div>
      </div>
    </>
  );
}
