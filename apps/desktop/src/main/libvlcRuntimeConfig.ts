// Shared by startup warmup and fallback instances. VLC can emit decoder
// diagnostics even while playback succeeds. Keep its native console output
// opt-in; player error states and LoomTV's own error reporting remain active.
//
// The plugin cache stays enabled. With a valid plugins.dat, libvlc_new maps
// only the core and loads each plugin when playback first needs it; without
// it, VLC dlopens all ~335 plugins and keeps them resident (measured: 466
// images, +32 MB and 630 ms at startup, +29 MB during playback). Release
// builds regenerate the cache after signing (scripts/after-sign.cjs). A stale
// entry only makes VLC load that one plugin directly, as it did before.
export const LIBVLC_INSTANCE_ARGUMENTS: readonly string[] = [
  ...(process.env.LOOMTV_DEBUG_LIBVLC === '1'
    ? ['--no-quiet', '--verbose=2']
    : ['--quiet']),
];
