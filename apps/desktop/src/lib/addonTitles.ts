import { useEffect, useState } from 'react';

const KEY = 'loomtv:addon-titles:v1';
const EVENT = 'loomtv:addon-titles-changed';

export function loadAddonTitles(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && Boolean(entry[1].trim()) && entry[1].length <= 120
    )));
  } catch { return {}; }
}

export function saveAddonTitle(addonId: string, title: string): void {
  const value = title.trim();
  if (!value || value.length > 120) throw new Error('Enter an add-on title between 1 and 120 characters.');
  window.localStorage.setItem(KEY, JSON.stringify({ ...loadAddonTitles(), [addonId]: value }));
  window.dispatchEvent(new Event(EVENT));
}

export function useAddonTitles(): Record<string, string> {
  const [titles, setTitles] = useState(loadAddonTitles);
  useEffect(() => {
    const refresh = () => setTitles(loadAddonTitles());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return titles;
}
