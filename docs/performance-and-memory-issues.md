# Video performance status

Updated by source inspection on 2026-10-24. This replaces the earlier issue list where it described fixes as missing. No new benchmarks, playback sessions, or memory measurements were run during this cleanup.

Paths below are relative to `apps/desktop/` unless specified otherwise.

## Already implemented

| Area | Current code | Remaining evidence |
| --- | --- | --- |
| Performance budgets | `scripts/check-performance-budgets.ts` checks scan persistence and 50,000-item projection time/RSS against `performance-budgets.json`. The Validate workflow runs it. | Broader packaged-playback and startup budgets are still needed. |
| Startup timing | `src/main/startupTiming.ts` records process, app, server, window, DOM, and first-library marks and retains ten launches. | Compare cold/warm packaged starts on each supported OS. |
| Main compile cache | `src/mainEntry.cjs` enables the Node compile cache before loading the main bundle. | Measure packaged ASAR behavior and actual startup savings. |
| Renderer code cache | `src/main.ts` enables the code-cache privilege for the `loomtv` scheme. | Confirm cache use and benefit in packaged builds. |
| LibVLC state updates | `src/main/libvlcPlayback.ts` suppresses unchanged state/sleep notifications and adjusts polling between 16 ms and 250 ms. | Measure paused CPU and verify subtitle/track timing. |
| mpv state updates | `src/main/libmpvPlayback.ts` suppresses unchanged state messages. It still polls every 16 ms. | Measure before reducing polling or changing render-host behavior. |
| Detail prefetch | `src/App.tsx` calls `prefetchLibraryDetails`; desktop detail reads use the shared query cache. | Measure hover-to-open latency and cache eviction with large libraries. |
| Partial downloads | `src/main/fileRename/fileSettling.ts` exports the shared partial-extension set used by cleanup and rename planning. | Exercise interrupted downloads when runtime tests are authorized. |

## Changed in this cleanup

Local-video and add-on ratings share normalization and missing-score fallback. The host de-duplicates in-flight requests, bounds its response cache, and applies OMDb/MDBList quota cooldowns. Automatic metadata refresh skips duplicate title searches when an exact provider ID is available. Movie refresh no longer asks TVmaze to supply data for a same-named television series. These reduce avoidable provider work; no latency or memory improvement has been measured here.

Workspace typechecks and declaration builds prefer tsrs, then Microsoft 7.1 beta, then 7.0.2 when a compiler cannot start. Compiler throughput does not measure app startup, video decoding, or playback memory.

Desktop and server now share canonical video tables. Folder mutations commit once, without a cross-store journal or network compensation. Revision checks invalidate native caches and stop stale scan checkpoints. Catalog filtering reuses one root/subfolder access snapshot per request. These changes reduce duplicate storage and repeated policy queries; their runtime cost has not been measured.

## Still needs measurement

- The initial HTML root is empty. Use the startup marks to establish whether users see a blank interval before adding a duplicate static layout.
- Record per-process memory for main, renderer, GPU, and native player during visible playback, pause, window hiding, and repeated player open/close cycles.
- Compare LibVLC, mpv, and browser/HLS with identical video, audio, subtitle, display-size, and acceleration settings on the same machine. Earlier development-build snapshots are not a current engine ranking.
- Separate retained caches from unbounded growth before lowering limits or rewriting an engine integration.
- Measure compatibility-view reads, scan writes, backup size, and concurrent desktop/server access. Exercise interrupted consolidation and rollback separately from performance measurements.

Use the existing benchmark scripts and startup recorder when testing is authorized. Save the build revision, OS/CPU, fixture, window state, and raw results with any performance claim. See [platform capabilities](platform-capabilities.md) for release verification requirements.
