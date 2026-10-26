import { useEffect, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import { useProfiles } from '@/contexts/ProfileContext';
import { DEFAULT_SIDEBAR_NAV_ORDER, normalizeSidebarNavOrder } from '@/lib/sidebarNavOrder';

export function useSidebarNavOrder() {
  const { activeProfile } = useProfiles();
  const [navOrder, setNavOrder] = useState(DEFAULT_SIDEBAR_NAV_ORDER);
  useEffect(() => {
    let active = true;
    let changed = false;
    const update = (event: Event) => {
      changed = true;
      setNavOrder(normalizeSidebarNavOrder((event as CustomEvent<string[]>).detail));
    };
    window.addEventListener('loomtv:sidebar-order-changed', update);
    void Promise.all([desktopApi.getSettings(), desktopApi.getProfilePreferences()])
      .then(([settings, preferences]) => {
        if (active && !changed) setNavOrder(normalizeSidebarNavOrder(preferences.sidebarNavOrder ?? settings.sidebarNavOrder));
      })
      .catch((error: unknown) => { console.warn('Could not load search filter order:', error); });
    return () => { active = false; window.removeEventListener('loomtv:sidebar-order-changed', update); };
  }, [activeProfile?.id]);
  return navOrder;
}
