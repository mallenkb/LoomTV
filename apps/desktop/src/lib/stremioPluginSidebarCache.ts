import type { StremioPluginSummary } from '@/shared/desktopProtocol';

const CACHE_KEY = 'loomtv:plugin-sidebar-cache:v1';
const pluginStates = new Set<StremioPluginSummary['state']>([
  'pending-review',
  'enabled',
  'disabled',
  'broken',
]);

export type CachedSidebarPlugin = Pick<StremioPluginSummary, 'addonId' | 'name' | 'state' | 'trusted'>;

function cachedSidebarPlugin(value: unknown): CachedSidebarPlugin | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CachedSidebarPlugin>;
  if (typeof candidate.addonId !== 'string' || !candidate.addonId.trim()) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  if (!candidate.state || !pluginStates.has(candidate.state)) return null;
  if (typeof candidate.trusted !== 'boolean') return null;
  return {
    addonId: candidate.addonId,
    name: candidate.name,
    state: candidate.state,
    trusted: candidate.trusted,
  };
}

export function loadCachedSidebarPlugins(): CachedSidebarPlugin[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.map(cachedSidebarPlugin).filter((plugin): plugin is CachedSidebarPlugin => Boolean(plugin))
      : [];
  } catch {
    return [];
  }
}

export function saveCachedSidebarPlugins(plugins: readonly StremioPluginSummary[]): void {
  const cached = plugins.map(({ addonId, name, state, trusted }) => ({ addonId, name, state, trusted }));
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    // A blocked renderer cache affects only the optional sidebar shortcut.
  }
}
