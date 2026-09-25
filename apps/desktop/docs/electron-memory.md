# Electron memory

This pass fixes retained data and artwork sizing without reducing playback buffers or moving duplicate state into a Rust process.

## Playback and idle cleanup

- A local player lease schedules one cleanup 15 seconds after the player opens, including when paused. Closing the player cancels pending cleanup. LAN playback alone does not trigger this renderer cleanup.
- Chromium cleanup runs during renderer idle time, with a five-second deadline, only when its resource counters report at least 16 MiB of unused image data. It does not delete the artwork disk cache. Attached images and seek previews retain their references.
- Inactive query results shrink to a 4 MiB estimate and 64 entries at these transitions. Active observers and pending reads are preserved. Recent details remain cached for Back navigation, and the mounted library keeps its scroll state.
- The shared probe cache keeps the most recent results within 8 MiB instead of emptying the entire cache. Scans skip this trimming.
- The main process releases its full library snapshot after five minutes without a library read, checked once per minute. Playback and scans prevent release. The renderer's compact catalog stays available, and later main-process reads reload the persisted database.
- Hidden, minimized and unfocused windows request cleanup after 30 seconds. Visible system inactivity retains the five-minute threshold. Cleanup timers stop at quit.

These changes do not alter LibVLC selection, hardware decoding, video quality, audio, decoder buffers or seek behavior. Their expected savings are in unused artwork and catalog data, not the active decoder's graphics surfaces. Production builds and static checks do not establish a measured memory reduction or prove unchanged playback responsiveness.

## Existing bounds

- Artwork cards already request smaller TMDB renditions. The helper now supports opaque cache capabilities and encoded legacy sources. The host resolves the authorized resource before selecting an allowed width. Other providers and signed remote URLs remain unchanged, and smaller existing images are never enlarged.
- Offscreen artwork placeholders now unload with the main image.
- Library reads retain their in-flight query for deduplication but use zero cache retention after completion. LibraryContext still owns the compact index. Full details remain on demand. This does not introduce database pagination or incremental IPC updates.
- Inactive query budgets now apply when the final observer leaves, even if no later request completes. Estimating a large result no longer allocates an array of every property name.
- LibVLC and MPV disposal release the renderer callback before awaiting native shutdown. Existing cleanup already stops sessions, clears tracks and timers, destroys HLS, removes browser media sources and stops transcoding.
- Artwork responses already stream cached files. Scan discovery and probe concurrency already have bounds. No additional Rust worker was added in this pass.

## Whole-app measurement

Launch the desktop process with `LOOM_MEMORY_METRICS=1` to emit a `[memory]` JSON record every ten seconds. Reporting is off by default and stops at quit. Records contain the main process heap, external allocations and RSS, plus Electron process working sets and peaks. They contain no library paths or media URLs.

Capture the same library while idle, browsing artwork, playing a fixed video, and after stopping playback. Compare the same operating system, window size, player and media. Electron's process metrics do not include every external helper, so scanner and native-player child processes need separate OS measurements. Adding working sets can double-count shared pages.

No whole-app runtime measurement or visual verification was performed in this pass. No overall memory reduction percentage is established. TypeScript checking and lint are static checks; tests were not run.
