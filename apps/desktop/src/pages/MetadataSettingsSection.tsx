import { Check, CheckCircle, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsActions, SettingsDisclosure, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow } from '@/components/settings/SettingsLayout';
import type { MetadataKeyTestResult } from '@/lib/desktopApi';
import { cn } from '@/lib/utils';
import { normalizeProviderId } from './Settings.helpers';
import type { MetadataProvider } from './Settings.types';

type MetadataSettingsSectionProps = {
  providers: MetadataProvider[];
  metadataKeys: Record<string, string>;
  editingKeys: Record<string, boolean>;
  visibleKeys: Record<string, boolean>;
  customProviders: string[];
  newProviderName: string;
  newProviderKey: string;
  savedKey: boolean;
  isTestingKeys: boolean;
  metadataKeyTestResults: MetadataKeyTestResult[];
  hasMetadataKeysToTest: boolean;
  setMetadataKey: (providerId: string, value: string) => void;
  setProviderEditing: (providerId: string, isEditing: boolean) => void;
  toggleProviderVisibility: (providerId: string) => void;
  deleteMetadataKey: (providerId: string) => void;
  setNewProviderName: (value: string) => void;
  setNewProviderKey: (value: string) => void;
  addMetadataKey: () => void;
  saveApiKeys: () => void;
  testApiKeys: () => void;
};

export default function MetadataSettingsSection({
  providers,
  metadataKeys,
  editingKeys,
  visibleKeys,
  customProviders,
  newProviderName,
  newProviderKey,
  savedKey,
  isTestingKeys,
  metadataKeyTestResults,
  hasMetadataKeysToTest,
  setMetadataKey,
  setProviderEditing,
  toggleProviderVisibility,
  deleteMetadataKey,
  setNewProviderName,
  setNewProviderKey,
  addMetadataKey,
  saveApiKeys,
  testApiKeys,
}: MetadataSettingsSectionProps) {
  const keyRow = (providerId: string, label: string, placeholder: string) => {
    const currentValue = metadataKeys[providerId] || '';
    const isEditing = editingKeys[providerId] ?? !currentValue;
    const isVisible = visibleKeys[providerId] || false;
    return (
      <div className="settings-key-row flex items-center gap-1.5">
        <input
          type={isEditing || isVisible ? 'text' : 'password'}
          value={currentValue}
          onChange={(event) => setMetadataKey(providerId, event.target.value)}
          placeholder={placeholder}
          readOnly={!isEditing}
          aria-label={label}
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] focus:border-[var(--loom-accent)] focus:outline-none read-only:text-[var(--loom-muted)]"
        />
        {currentValue ? (
          <>
            <Button type="button" size="icon" variant="outline" onClick={() => toggleProviderVisibility(providerId)} title={isVisible ? `Hide ${label}` : `Show ${label}`} aria-label={isVisible ? `Hide ${label}` : `Show ${label}`} className="h-9 w-9 shrink-0">
              {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button type="button" size="icon" variant="outline" onClick={() => setProviderEditing(providerId, !isEditing)} title={isEditing ? `Done editing ${label}` : `Edit ${label}`} aria-label={isEditing ? `Done editing ${label}` : `Edit ${label}`} className="h-9 w-9 shrink-0">
              {isEditing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </Button>
            <Button type="button" size="icon" variant="outline" onClick={() => deleteMetadataKey(providerId)} title={`Delete ${label}`} aria-label={`Delete ${label}`} className="settings-destructive-text h-9 w-9 shrink-0">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div>
      <SettingsPageHeader title="Metadata keys" description="API keys for posters, cast, episode data, ratings, and logos." />
      <SettingsGroup
        title="Metadata services"
        description="TVmaze, Jikan, and Cinemeta need no key. Add keys only for the services you want."
      >
        {providers.map((provider) => (
          <SettingsRow
            key={provider.id}
            stacked
            title={(
              <span className="flex items-center gap-2">
                {provider.label.replace(/ API Key$/, '')}
                {provider.badge ? (
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-normal ${provider.required ? 'bg-[var(--loom-accent)]/15 text-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}>{provider.badge}</span>
                ) : null}
              </span>
            )}
            description={provider.description}
          >
            {keyRow(provider.id, provider.label, provider.placeholder)}
          </SettingsRow>
        ))}

        {customProviders.map((providerId) => (
          <SettingsRow key={providerId} stacked title={providerId}>
            {keyRow(providerId, providerId, 'API key')}
          </SettingsRow>
        ))}

        <SettingsDisclosure title="Add another service key" description="For add-ons or providers that ask for their own key.">
          <div className="settings-key-row settings-key-row-new flex items-center gap-1.5">
            <input
              type="text"
              value={newProviderName}
              onChange={(event) => setNewProviderName(event.target.value)}
              placeholder="Service name, e.g. fanart"
              aria-label="Service name"
              className="h-9 w-52 shrink-0 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] focus:border-[var(--loom-accent)] focus:outline-none"
            />
            <input
              type="text"
              value={newProviderKey}
              onChange={(event) => setNewProviderKey(event.target.value)}
              placeholder="API key"
              aria-label="API key"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] focus:border-[var(--loom-accent)] focus:outline-none"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addMetadataKey}
              disabled={!normalizeProviderId(newProviderName) || !newProviderKey.trim()}
              className="h-9 gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </SettingsDisclosure>

        {metadataKeyTestResults.map((result) => (
          <SettingsNote key={result.provider} tone={result.ok ? 'muted' : 'error'}>
            <span className="flex items-start gap-2">
              <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', result.ok ? 'bg-emerald-400' : 'bg-red-400')} />
              <span><span className="font-semibold uppercase">{result.provider}</span> · {result.message}</span>
            </span>
          </SettingsNote>
        ))}

        <SettingsActions start="Test checks each key with its service.">
          <Button type="button" variant="outline" size="sm" onClick={testApiKeys} disabled={isTestingKeys || !hasMetadataKeysToTest} className="gap-1.5">
            {isTestingKeys ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
            {isTestingKeys ? 'Testing…' : 'Test keys'}
          </Button>
          <Button type="button" size="sm" onClick={saveApiKeys} className="gap-1.5">
            {savedKey ? <CheckCircle className="h-3.5 w-3.5" /> : null}
            {savedKey ? 'Saved' : 'Save keys'}
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </div>
  );
}
