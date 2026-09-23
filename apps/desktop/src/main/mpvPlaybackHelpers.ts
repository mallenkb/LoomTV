import path from 'node:path';
import type { MpvPlaybackTrack } from '../shared/desktopProtocol.ts';

export type SubtitleSource = 'sidecar' | 'opensubtitles';

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeMpvTracks(
  value: unknown,
  subtitleSources: ReadonlyMap<string, SubtitleSource>,
): MpvPlaybackTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MpvPlaybackTrack[] => {
    if (!entry || typeof entry !== 'object') return [];
    const track = entry as Record<string, unknown>;
    const type = track.type === 'video' || track.type === 'audio' || track.type === 'sub'
      ? track.type
      : null;
    const id = finiteNumber(track.id);
    if (!type || id === undefined) return [];
    const externalPath = typeof track['external-filename'] === 'string'
      ? path.resolve(track['external-filename'])
      : null;
    return [{
      id,
      type: type === 'sub' ? 'subtitle' : type,
      codec: typeof track.codec === 'string' ? track.codec : undefined,
      language: typeof track.lang === 'string' ? track.lang : undefined,
      title: typeof track.title === 'string' ? track.title : undefined,
      channels: finiteNumber(track['demux-channel-count']),
      default: track.default === true,
      forced: track.forced === true,
      selected: track.selected === true,
      external: track.external === true,
      source: externalPath ? subtitleSources.get(externalPath) || 'sidecar' : 'embedded',
    }];
  });
}

const hexByte = (value: number): string => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');

/**
 * Convert a CSS color into mpv's #AARRGGBB form, or null when it cannot be
 * represented. mpv rejects CSS names, rgb()/rgba(), and "transparent", and it
 * reads eight-digit hex with alpha first, while CSS puts alpha last.
 */
export function mpvColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return '#00000000';
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const rgb = full.slice(0, 6);
    const alpha = full.length === 8 ? full.slice(6, 8) : 'ff';
    return `#${alpha}${rgb}`;
  }
  const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  if (!functional) return null;
  const [red, green, blue] = functional.slice(1, 4).map(Number);
  const alphaText = functional[4];
  const alpha = alphaText === undefined
    ? 1
    : alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  if (![red, green, blue, alpha].every(Number.isFinite)) return null;
  return `#${hexByte(Math.max(0, Math.min(1, alpha)) * 255)}${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}
