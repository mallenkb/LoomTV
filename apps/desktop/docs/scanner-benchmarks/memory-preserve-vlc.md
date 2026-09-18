# Memory changes with LibVLC kept warm

## Preserved behavior

LibVLC remains the first local playback engine and the IPTV engine. Its startup
`libvlc_new()` call, plugin options, shared instance, and app-lifetime retention
are unchanged. The existing 1.5-second availability probe is kept. The decoder,
video output, hardware acceleration, seek scheduling, and fullscreen behavior
are not changed. Pausing or backgrounding active playback does not destroy it.

This change does not introduce a LibVLC helper process, switch to MPV by default,
force garbage collection, clear the disk artwork cache, or promise a fixed RAM cap.

## Changes

- MPV availability and startup logging only check paths. The bridge and core load
  when playback actually selects MPV. Availability distinguishes `detected` from
  `loaded`; detection is not proof that a library can play a file.
- The global idle route preload and idle import of the renderer player are removed.
  Existing navigation and hover/focus route loading remain. The first opening of
  an unused route or the player can now include its JavaScript import cost.
- LibVLC availability reuses the native library handles created during warmup.
  A different library path never borrows the warm runtime's handles or instance.
  This removes redundant loader references, not a claimed second copy of VLC RAM.
- The main process's complete library snapshot expires after 30 seconds without
  reads. Eviction drops a reference; it does not mutate in-flight scan snapshots
  or erase the database. A miss uses the existing database/migration read path.
- Renderer-facing compact indexes are bounded to two entries and an 8 MiB
  encoded-payload estimate, with 60-second idle expiry. Detail reads are bounded
  to 50 entries and 8 MiB, with 30-second idle expiry. Oversized results still
  return to callers but are not cached. Profile/restriction/transport changes and
  catalog mutations invalidate projected caches. LAN projections and their
  authorization remain uncached and unchanged.
- Automatic library scans wait while the app is hidden or playback is active;
  remote catalog polling also waits during playback. Explicit scans and active
  server/remote playback are not terminated.
- Opt-in memory logs include main-process private memory, separate process
  metrics, and VLC/MPV start/release checkpoints. No media identifiers are logged.

The full database read still materializes a catalog on a cold miss. This patch
bounds retention rather than replacing the storage layer with paginated SQL.
Continuous scans or other active readers can legitimately retain a full snapshot.
The LRU byte accounting measures serialized payloads, not all V8 object overhead.

## Measurement

The engineering target is the first LoomTV row in Activity Monitor: aim below
600 MB in ordinary use, then investigate whether 400 MB is achievable. Neither
number is a tested maximum. Helpers are separate processes. Native decoder/GPU
memory, codec, resolution, library size, and OS accounting affect the result.

Use the same installed release build, machine, library, and media for both runs.
Launch the built app with `LOOM_MEMORY_METRICS=1` in its environment. Record:

1. Fresh launch after the library and VLC warmup settle.
2. Browsing a repeatable set of routes.
3. 1080p playback, pause, and close.
4. 4K/HEVC playback, pause, fullscreen, seek, and close.
5. IPTV channel changes and exit.
6. A deliberately unavailable VLC runtime to exercise MPV fallback.
7. Ten open/close cycles, then at least 60 seconds without catalog reads.

Compare `mainPrivateBytes`, Node RSS, `heapUsed`, `external`, and the per-process
metrics separately. `arrayBuffers` is included in `external`; do not add it twice.
RSS minus JavaScript heap does not identify the native allocator responsible.
A single high sample is not proof of a leak. Compare settled memory and repeated
cycle growth, then use macOS Instruments/VM Tracker for retained native allocations.

The retained LibVLC base instance is intentional. Session cleanup still releases
players, media, native views, timers and listeners. Freeing these objects does not
guarantee an immediate fall in OS-reported footprint. Native library mappings can
remain after use; the code does not attempt unsafe `dlclose()` calls.

## Verification boundary

Unit tests cover cache expiry/limits, missing MPV detection, on-demand MPV loading,
LibVLC startup warming, and reuse of its loaded libraries. The existing native
session lifecycle tests exercise mocked transports, not a live Mac decoder.
Actual Activity Monitor savings and click-to-first-frame behavior require the
macOS comparison above. Automated check outcomes are recorded alongside this file.
