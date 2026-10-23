import { useMemo, useSyncExternalStore } from 'react';
import type { StremioStreamDescriptor } from '@/shared/desktopProtocol';

export const addonResolutionOptions = [
  { value: 'all', label: 'All resolutions' },
  { value: '4320', label: '8K / 4320p' },
  { value: '2160', label: '4K / 2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
  { value: 'sd', label: 'SD' },
  { value: 'unknown', label: 'Unspecified' },
] as const;
export type AddonResolution = typeof addonResolutionOptions[number]['value'];
export type AddonSourcePreferences = { resolutions: AddonResolution[]; suggestedFirst: boolean };
const KEY = 'loomtv:addon-source-preferences:v1';
const EVENT = 'loomtv:addon-source-preferences-changed';

function snapshot(): string {
  try { return window.localStorage.getItem(KEY) || ''; } catch { return ''; }
}
function parse(raw: string): AddonSourcePreferences {
  try {
    const value = JSON.parse(raw);
    const saved = Array.isArray(value?.resolutions) ? value.resolutions : [value?.resolution];
    const resolutions = addonResolutionOptions.filter(option => saved.includes(option.value)).map(option => option.value);
    return {
      resolutions: resolutions.includes('all') ? ['all'] : resolutions.length === 0
        || (value?.version !== 2 && resolutions.length === 1 && resolutions[0] === '1080') ? ['1080', '720'] : resolutions,
      suggestedFirst: typeof value?.suggestedFirst === 'boolean' ? value.suggestedFirst : true,
    };
  } catch { return { resolutions: ['1080', '720'], suggestedFirst: true }; }
}
function subscribe(callback: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) callback(); };
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', storage); };
}
export function useAddonSourcePreferences(): AddonSourcePreferences {
  const raw = useSyncExternalStore(subscribe, snapshot, () => '');
  return useMemo(() => parse(raw), [raw]);
}
export function saveAddonSourcePreferences(change: Partial<AddonSourcePreferences>): void {
  window.localStorage.setItem(KEY, JSON.stringify({ version: 2, ...parse(JSON.stringify({ version: 2, ...parse(snapshot()), ...change })) }));
  window.dispatchEvent(new Event(EVENT));
}

/** Provider labels are hints, not measurements of the video or live availability. */
export function sourceResolution(stream: StremioStreamDescriptor): AddonResolution {
  for (const text of [stream.name || '', stream.description || '']) {
    const dimensions = /(?:^|\D)\d{3,5}\s*[x×]\s*(4320|2160|1440|1080|720|480|360)(?:\D|$)/i.exec(text);
    if (dimensions) return dimensions[1] as AddonResolution;
    const match = /(?:^|[^a-z0-9])(4320|2160|1440|1080|720|480|360)(?:p(?:\d{2,3})?)?(?:$|[^a-z0-9])/i.exec(text);
    if (match) return match[1] as AddonResolution;
    if (/(?:^|[^a-z0-9])8k(?:$|[^a-z0-9])/i.test(text)) return '4320';
    if (/(?:^|[^a-z0-9])(?:4k|uhd)(?:$|[^a-z0-9])/i.test(text)) return '2160';
    if (/(?:^|[^a-z0-9])sd(?:$|[^a-z0-9])/i.test(text)) return 'sd';
  }
  return 'unknown';
}
function sourceHints(stream: StremioStreamDescriptor) {
  const text = `${stream.name || ''}\n${stream.description || ''}`;
  const seeders = /(?:👤\s*|\bseeders?\s*[:=]\s*)(\d[\d,]*)(?:\b|\s)/i.exec(text);
  const count = seeders ? Number(seeders[1].replaceAll(',', '')) : undefined;
  const direct = stream.transport === 'media' || stream.transport === 'hls';
  const unsupported = stream.transport === 'unsupported' || stream.transport === 'peer-to-peer' || stream.requestHeadersRequired;
  const downloading = /\[(?:RD|AD|PM|TB|DL|OC|ED)\s+download\]/i.test(text);
  const cached = direct && /\[(?:RD|AD|PM|TB|DL|OC|ED)\+\]/i.test(text);
  const rank = unsupported ? 6 : downloading ? 4 : cached ? 0 : direct ? 1
    : stream.transport === 'torrent' ? (count !== undefined && count > 0 ? 2 : 3) : 5;
  return { rank, seeders: stream.transport === 'torrent' ? count ?? -1 : -1 };
}

export function filterAddonSources(streams: readonly StremioStreamDescriptor[], preferences: AddonSourcePreferences): StremioStreamDescriptor[] {
  const filtered = streams.filter(stream => preferences.resolutions.includes('all') || preferences.resolutions.includes(sourceResolution(stream)));
  if (!preferences.suggestedFirst) return filtered;
  return filtered.map((stream, index) => ({ stream, index, ...sourceHints(stream) }))
    .sort((a, b) => a.rank - b.rank || b.seeders - a.seeders || a.index - b.index)
    .map(item => item.stream);
}

export type AddonSourceSort = 'preferred' | 'size-asc' | 'size-desc' | 'seeders-desc' | 'seeders-asc' | 'source-asc';

export function torrentSource(stream: StremioStreamDescriptor): string {
  const match = /(?:⚙️?\s*|(?:^|\n)(?:source|provider)\s*:\s*)([^\n|]+)/i.exec(stream.description || '');
  return match?.[1].trim() || 'Unspecified';
}

/** Sizes and seeders are reported by the provider, not measured locally. */
export function sortAddonSources(streams: readonly StremioStreamDescriptor[], order: AddonSourceSort): StremioStreamDescriptor[] {
  if (order === 'preferred') return [...streams];
  if (order === 'source-asc') return [...streams].sort((a, b) => {
    const left = torrentSource(a), right = torrentSource(b);
    if (left === 'Unspecified') return right === 'Unspecified' ? 0 : 1;
    if (right === 'Unspecified') return -1;
    return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
  });
  const size = (stream: StremioStreamDescriptor): number | undefined => {
    const match = /(?:^|[^\d.])(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)\b/i.exec(stream.description || '');
    if (!match) return undefined;
    const unit = match[2].toUpperCase();
    const power = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[unit];
    return power === undefined ? undefined : Number(match[1].replace(',', '.')) * (unit.includes('I') ? 1024 : 1000) ** power;
  };
  const seeding = order.startsWith('seeders');
  const direction = order.endsWith('asc') ? 1 : -1;
  return streams.map((stream, index) => {
    const reported = sourceHints(stream).seeders;
    return { stream, index, value: seeding ? reported < 0 ? undefined : reported : size(stream) };
  }).sort((a, b) => {
    if (a.value === undefined) return b.value === undefined ? a.index - b.index : 1;
    if (b.value === undefined) return -1;
    return direction * (a.value - b.value) || a.index - b.index;
  }).map(item => item.stream);
}
