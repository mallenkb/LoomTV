/**
 * Configuration surface for the experimental local LibVLC pilot.
 *
 * This module is deliberately isolated from playback and IPC. The pilot is
 * disabled by default and remains disabled unless a future integration proves
 * that a supported, packaged LibVLC runtime is present.
 */

export const LIBVLC_PILOT_FLAG = 'LOOMTV_EXPERIMENTAL_LIBVLC';
export const LIBVLC_PILOT_KILL_SWITCH = 'LOOMTV_DISABLE_EXPERIMENTAL_LIBVLC';

export const LIBVLC_PILOT_FALLBACK = 'mpv' as const;

/** No LibVLC runtime is currently bundled or supported by the desktop package. */
export const LIBVLC_PILOT_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = [];

export type LibVlcPilotState = {
  requested: boolean;
  enabled: boolean;
  fallback: typeof LIBVLC_PILOT_FALLBACK;
  reason: 'disabled-by-default' | 'kill-switch' | 'runtime-not-bundled' | 'unsupported-platform' | 'enabled';
};

type LibVlcPilotOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** A future runtime probe must opt in explicitly; absence is unavailable. */
  packagedRuntimeAvailable?: boolean;
};

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'on';
}

/**
 * Resolve the pilot state without ever assuming that a runtime exists.
 *
 * Setting the experiment flag alone is intentionally insufficient. A future
 * LibVLC integration must pass `packagedRuntimeAvailable: true` after it has
 * validated the exact packaged runtime and target architecture.
 */
export function resolveLibVlcPilotState({
  env = process.env,
  platform = process.platform,
  packagedRuntimeAvailable = false,
}: LibVlcPilotOptions = {}): LibVlcPilotState {
  const requested = isTruthyFlag(env[LIBVLC_PILOT_FLAG]);
  if (isTruthyFlag(env[LIBVLC_PILOT_KILL_SWITCH])) {
    return { requested, enabled: false, fallback: LIBVLC_PILOT_FALLBACK, reason: 'kill-switch' };
  }
  if (!requested) {
    return { requested: false, enabled: false, fallback: LIBVLC_PILOT_FALLBACK, reason: 'disabled-by-default' };
  }
  if (!packagedRuntimeAvailable) {
    return { requested: true, enabled: false, fallback: LIBVLC_PILOT_FALLBACK, reason: 'runtime-not-bundled' };
  }
  if (!LIBVLC_PILOT_SUPPORTED_PLATFORMS.includes(platform)) {
    return { requested: true, enabled: false, fallback: LIBVLC_PILOT_FALLBACK, reason: 'unsupported-platform' };
  }
  return { requested: true, enabled: true, fallback: LIBVLC_PILOT_FALLBACK, reason: 'enabled' };
}
