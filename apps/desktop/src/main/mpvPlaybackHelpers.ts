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

export function isLikelyNaturalMpvEof(input: {
  code: number | null;
  position?: number;
  duration?: number;
  toleranceSeconds?: number;
}): boolean {
  const { code, position, duration, toleranceSeconds = 2 } = input;
  return code === 0
    && typeof position === 'number'
    && typeof duration === 'number'
    && duration > 0
    && position >= duration - Math.max(0, toleranceSeconds);
}

export function unexpectedMpvExitMessage(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string;
}): string {
  const exit = input.signal ? `signal ${input.signal}` : input.code === null ? 'unknown status' : `code ${input.code}`;
  const detail = input.stderr?.trim();
  return `mpv exited unexpectedly (${exit})${detail ? `: ${detail}` : '.'}`;
}
