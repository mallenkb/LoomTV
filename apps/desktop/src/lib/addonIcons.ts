import { useEffect, useState } from 'react';
import { ADDON_SUPPORTED_ICON_OPTIONS, type AddonExtraIconId } from '@/components/AddonSourceIcons';
import type { IptvSourceIconId } from '@/shared/desktopProtocol';

export type AddonIconId = IptvSourceIconId | AddonExtraIconId | 'default';
const KEY = 'loomtv:addon-icons:v1';
const EVENT = 'loomtv:addon-icons-changed';
const valid = (value: unknown): value is AddonIconId => value === 'default' || ADDON_SUPPORTED_ICON_OPTIONS.some(option => option.id === value);

export function loadAddonIcons(): Record<string, AddonIconId> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, AddonIconId] => valid(entry[1])));
  } catch { return {}; }
}

export function saveAddonIcon(addonId: string, icon: AddonIconId): void {
  if (!valid(icon)) throw new Error('Choose a supported add-on icon.');
  window.localStorage.setItem(KEY, JSON.stringify({ ...loadAddonIcons(), [addonId]: icon }));
  window.dispatchEvent(new Event(EVENT));
}

export function useAddonIcons(): Record<string, AddonIconId> {
  const [icons, setIcons] = useState(loadAddonIcons);
  useEffect(() => {
    const refresh = () => setIcons(loadAddonIcons());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return icons;
}
