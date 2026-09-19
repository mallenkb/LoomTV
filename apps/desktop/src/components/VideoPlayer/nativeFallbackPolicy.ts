import type { PlaybackStartOptions } from './engines/PlaybackEngine';

export type NativeDecodeAttempt = {
  engine: 'libvlc' | 'mpv';
  decodeMode?: PlaybackStartOptions['decodeMode'];
};

const LOCAL_ATTEMPTS: readonly NativeDecodeAttempt[] = [
  { engine: 'libvlc', decodeMode: 'hardware' },
  { engine: 'mpv', decodeMode: 'hardware' },
  // Prefer mpv for software decode as a policy heuristic. Performance varies
  // by file, decoder, and machine, so retain VLC software as another option.
  { engine: 'mpv', decodeMode: 'software' },
  { engine: 'libvlc', decodeMode: 'software' },
];

const IPTV_ATTEMPTS: readonly NativeDecodeAttempt[] = [{ engine: 'libvlc' }];

export function nativeAttemptsForSource(source: 'local' | 'iptv' | 'other'): readonly NativeDecodeAttempt[] {
  if (source === 'local') return LOCAL_ATTEMPTS;
  if (source === 'iptv') return IPTV_ATTEMPTS;
  return [];
}

export function nativeStartOptionsForAttempt(
  attempt: NativeDecodeAttempt,
  state: Omit<PlaybackStartOptions, 'decodeMode'>,
): PlaybackStartOptions {
  return { ...state, decodeMode: attempt.decodeMode };
}
