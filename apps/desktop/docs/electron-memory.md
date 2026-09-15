# Electron memory

This pass fixes retained data and artwork sizing without reducing playback buffers or moving duplicate state into a Rust process.

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
