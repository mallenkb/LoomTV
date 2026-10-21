import { useEffect, useState } from 'react';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi } from '@/lib/desktopApi';
import type { CachedSidebarPlugin } from '@/lib/stremioPluginSidebarCache';

export const ARCHIVE_MANIFEST_URL = 'https://dev.nebulawp.org/stremio/archive.org-addon/manifest.json';

/** Resolve the shared Archive listing without fetching or scraping arbitrary pages. */
export function stremioManifestInput(value: string): string {
  let url: URL;
  // The host validates every other link and explains what is wrong with it.
  try { url = new URL(value.trim()); } catch { return value.trim(); }
  const path = url.pathname.replace(/\/$/, '');
  if ((url.origin === 'https://stremio-addons.net' && path === '/addons/archive.org')
    || (url.origin === 'https://addons-stremio.com' && path === '/addon/archive-org')) return ARCHIVE_MANIFEST_URL;
  return value.trim();
}

/** Shortcuts follow the current profile's allowed sources, rather than a global cache. */
export function useStremioSidebarSources(): CachedSidebarPlugin[] {
  const { activeProfile } = useProfiles();
  const [snapshot, setSnapshot] = useState<{ profileId: string; sources: CachedSidebarPlugin[] }>({ profileId: '', sources: [] });
  const profileId = activeProfile?.id || '';
  useEffect(() => {
    let mounted = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const plugins = profileId ? await desktopApi.listAvailableStremioPlugins() : [];
        if (mounted && generation === current) setSnapshot({ profileId, sources: plugins.map(plugin => ({
          addonId: plugin.addonId, name: plugin.name, state: plugin.state, trusted: plugin.trusted,
          catalogCount: plugin.catalogs.length, resources: plugin.resources, configured: plugin.configured,
        })) });
      } catch { if (mounted && generation === current) setSnapshot({ profileId, sources: [] }); }
    };
    const onPluginsChanged = () => { void refresh(); };
    void refresh();
    window.addEventListener('loomtv:plugins-changed', onPluginsChanged);
    return () => { mounted = false; window.removeEventListener('loomtv:plugins-changed', onPluginsChanged); };
  }, [profileId]);
  return snapshot.profileId === profileId ? snapshot.sources : [];
}
