# Performance and memory issues

Written 2026-10-05. This list applies the method from the post [How we made claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/) to LoomTV. The method has three steps. Measure first, fix the biggest offenders, then lock the gains in with CI checks whose limits can only go down.

Nothing in this document has been fixed yet. Each issue says whether its cost was measured or is still a guess.

Another Claude session (`5701754c`) was profiling startup and time to first frame on 2026-10-05, using a copy of the library and CDP port 9333. Check its findings before starting on issues 3 to 6, and don't run benchmarks while it runs its own.

## What LoomTV already does

- Hovering a card loads the detail page's code and starts its data request (TanStack Router `defaultPreload: 'intent'` plus `warmDetails`, `src/App.tsx:665` and `:721`).
- Long lists use TanStack Virtual.
- Artwork checks run in a worker thread (`src/main/artworkSecurity.ts`). The scanner runs as a separate Rust process.
- Benchmark scripts exist for library load and the scan pipeline (`apps/desktop/scripts/benchmark-*.ts`).
- The 2026-09 playback-memory audit already fixed the VLC buffer pool growth while the window is hidden or the screen is locked. It also fixed the dock icon cost and the thumbnail cache, and capped the HTTP cache.

All paths below are relative to `apps/desktop/` unless they start with `apps/` or `packages/`.

## Issues

### 1. No CI check catches performance or memory regressions

**Area.** Performance and memory. **Cost.** Indirect. Every past win can quietly regress.

The five benchmark scripts in `scripts/` (`benchmark-library-load.ts`, `benchmark-scan-persistence.ts`, `benchmark-scan-pipeline.ts`, `benchmark-scan-projection.ts`, `benchmark-scanner.ts`) write JSON to `/tmp`. No workflow in `.github/workflows` runs them.

Memory numbers are recorded only in Claude's notes. These were measured on the dev build with a hidden window on 2026-10-01.

| State | Total footprint |
| --- | --- |
| Idle | about 600 MB |
| LibVLC playback (with the hidden-window fix) | about 450 MB (854 MB before the fix) |
| libmpv playback | about 800 MB, including about 200 MB of GL render targets in main |
| HTML/HLS playback | about 900 MB |

**Fix.**
- Run the benchmark scripts in CI and fail when a result goes over a stored ceiling. Lower the ceiling whenever a change improves the number.
- Add a nightly macOS job that plays a fixture file with each engine and checks `footprint -p <pid>` for main, the renderer and the GPU helper against ceilings.
- Track the libmpv leftover after closing the player (30 to 80 MB) as its own number.

The post notes that Valgrind instruction counts are steadier than wall-clock time. Valgrind doesn't run on Apple silicon Macs, so that part needs a Linux runner.

### 2. LibVLC sends its full state to the renderer every 16 ms, even when nothing changed

**Area.** Performance (CPU in main and the renderer). **Cost.** Not measured.

After startup, `poll()` runs every 16 ms (`src/main/libvlcPlayback.ts:1179` and `:1782`). Every tick ends in `emit()` (`:1628`), which does the following:
- Copies the whole state object.
- Calls `syncNativePlaybackDisplaySleep`. While paused, that call makes an extra `playerGetState` native call.
- Sends `libvlc:state` over IPC.

All of this happens while paused too, when position, status and pause state stay the same.

A code comment says the 16 ms rate keeps native subtitle overlays in step with the picture, so the rate should stay during playback.

**Fix.** Keep the last sent state and skip `send` and the sleep sync when status, paused, duration and position are unchanged. While paused, the message count should drop to zero. `libmpvPlayback.ts:281` also polls every 16 ms. Check whether it sends on every tick before changing it.

**Verify.**
- Count `libvlc:state` messages per second while playing and while paused, before and after.
- Sample CPU of the main and renderer processes with a paused video.
- Confirm subtitle timing is unchanged on a file with dense cues.

`refreshNativeTracks` also reads every track description and builds a JSON signature every 500 ms during playback. That's a smaller cost, but it should be included in the same before-and-after measurement.

### 3. Startup has no timing marks

**Area.** Performance. **Cost.** Unknown, which is the problem.

The only startup event is `desktop.window.revealed` in the playback diagnostics. That diagnostic log is only printed with `LOOMTV_DEBUG_PLAYBACK=1`. Nothing records process start, `app.whenReady`, window created, renderer `domContentLoaded`, or the first library render.

**Fix.** Record those marks on every launch and write them to the diagnostics log. Keep the last few launches so a slow start can be compared with a normal one. Items 4 to 6 should wait for these numbers.

### 4. The main process recompiles its 2.6 MB bundle on every launch

**Area.** Performance (cold start). **Cost.** Partly measured.

`.vite/build/main.js` is 2,678,632 bytes. Under Electron 43.1.1 (Node 24.18), compiling its top level took 14.9 to 17.3 ms over three runs, and 0.1 to 0.2 ms with a V8 code cache (588 KB). Functions that V8 compiles lazily during startup add to that, so the real saving is larger. Given the bundle size, expect tens of milliseconds, not seconds. The post got about 3 s off a much larger bundle.

**Fix.**
- Add a small entry file that calls `module.enableCompileCache(<userData>/v8-cache)` and then loads `main.js`. The API exists in this Electron's Node.
- Test that it actually works for an asar-packaged main process.
- Measure cold start before and after with the marks from item 3.

### 5. The renderer may get no V8 code cache

**Area.** Performance (cold start). **Cost.** Not measured. The cause is also unverified.

The packaged app loads the renderer with `loadFile` (`src/main/windowManager.ts:197`), which serves it from `file://`. Chromium may not keep a code cache for `file://` scripts, and Electron may let a custom privileged scheme opt in. Check both claims in the Electron docs before acting on them.

### 6. The window can show a blank page while React loads

**Area.** Performance (perceived startup). **Cost.** Not measured.

`index.html` contains only an empty `<div id="root">`. The window appears on `ready-to-show`, on `did-finish-load`, or after 1.5 s (`src/main/windowManager.ts:183` to `:188`), whichever comes first. Until React mounts, the user sees the dark background and nothing else.

**Fix.** Put a static sidebar and grid outline in `index.html` that matches the React layout exactly, which is the post's static composer idea. The post also used tests to check the static and React versions line up within 1 px. Only do this if item 3 shows a visible gap.

### 7. The hover prefetch for detail pages may be wasted

**Area.** Performance (opening a detail page). **Cost.** Not measured.

`warmDetails` (`src/App.tsx:665`) calls `desktopApi.getLibraryItem(id)` and throws away the result. The router keeps nothing either (`defaultPreloadStaleTime: 0, defaultGcTime: 0`, `src/App.tsx:722`), and the app has no query cache. Unless the main process caches that IPC result, the detail page fetches it again, and hovering only warms SQLite's page cache. The `preloadingDetails` flag also allows only one prefetch at a time, so moving across a row of cards prefetches only the first one.

**Fix.**
- Check whether main caches `getLibraryItem`.
- If it doesn't, keep the prefetched result briefly in the renderer, keyed by ID with a short expiry, and have the detail page use it.
- Measure the time from click to rendered detail page before and after.

### 8. Memory that is not yet explained

**Area.** Memory. **Cost.** Measured totals, unknown causes.

- **Idle at about 600 MB.** No breakdown by process or by heap and native memory exists for the idle state.
- **HTML/HLS playback at about 900 MB, the highest of the three engines.** Chromium already stops decoding while the window is hidden, so the rest is unexplained.
- **libmpv holding 30 to 80 MB after the player closes.** This didn't grow over 3 cycles, so it's probably a cache, but nobody has confirmed what it is.
- **GPU helper at about 209 MB.** Turning off every `backdrop-filter` didn't change this, so blur is ruled out. Nothing else has been tested.

**Next step.** Take heap snapshots of main and the renderer at idle, and `footprint -v` per process, then rank the biggest items before deciding on fixes.

## Parts of the post that don't apply

- **Streaming renderer rebuild.** LoomTV doesn't stream text into the page the way a chat reply does.
- **One-byte string copies.** The post copied code into one-byte strings to speed up a regex. In LoomTV, the non-ASCII characters in subtitles are part of the dialogue and can't be removed.
- **Chrome prerender layout fix.** This is a browser-only problem.
- **Staged rollout with real user data.** The app collects no performance data from real users. The closest equivalent is shipping risky changes to a beta update channel first.

## Other open issues from the same review

These came up while checking Claude's project notes and the file-organize code. They don't affect performance.

1. **Three partial-download lists disagree.** `src/main/fileRename/fileSettling.ts` and `src/main/libraryCleanup.ts` list `part`, `partial`, `crdownload`, `download`, `fdmdownload` and `opdownload`. `src/main/fileRename/renamePlanner.ts:409` has its own list, which adds `.!qb` and `.!ut` and leaves out `.opdownload`. The proposed fix:
   - Export one list from `fileSettling.ts` and use it in all three places.
   - Change the folder check to treat any recently written file as still downloading, not only video files.
2. **Nothing in the repo writes the `.loomtv-clean-*.ass` files.** Commit ad56d91 taught the scanner to recognize them, and they are recognized in `scanClassification.ts`, `subtitleLanguage.ts` and `renamePlanner.ts`. Cleanup currently keeps them. The proposal is to let cleanup move them into its batch, where they stay restorable for 30 days, after confirming that the player's own ASS cleaning covers what they did.
3. **Release-group lists in title cleaning.** These are `src/lib/episodeTitles.ts:25`, `src/main/libraryItemHelpers.ts:41` and `src/main/metadata/helpers.ts:85`. The recommendation is to keep them, because they help metadata matching.
4. **Claude's project notes for LoomTV are out of date.** Most links between notes are broken, and several facts are stale (versions, branch status, file paths, line counts). One note is 10.7 KB and mixes unrelated topics. Your preferences are buried inside project notes. This needs a cleanup pass, which hasn't been done.
