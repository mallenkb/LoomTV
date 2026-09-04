// Shared by startup warmup and fallback instances. VLC can emit decoder
// diagnostics even while playback succeeds. Keep its native console output
// opt-in; player error states and LoomTV's own error reporting remain active.
export const LIBVLC_INSTANCE_ARGUMENTS: readonly string[] = [
  '--no-plugins-cache',
  ...(process.env.LOOMTV_DEBUG_LIBVLC === '1'
    ? ['--no-quiet', '--verbose=2']
    : ['--quiet']),
];
