# Saved playback improvements

The complete earlier implementation is preserved on the pushed branch [codex/future-playback-improvements-20260919](https://github.com/mallenkb/LoomTV/tree/codex/future-playback-improvements-20260919), at commit `8e793af6`.

This is a source snapshot, not a stash. To inspect it without replacing your working tree:

```sh
git fetch origin
git worktree add ../LoomTV-future origin/codex/future-playback-improvements-20260919
```

## Deferred work

- Cross-platform hardware-first VLC/mpv fallback, decoder verification and native bridges.
- Broader playback memory, polling and snapshot changes.
- Artwork caching, hidden-artwork suspension and query-cache changes.
- Subtitle positioning and other player behavior changes outside timeline previews and control spacing.
- Associated packaging changes, tests and measurement reports.

The saved branch includes experimental work and platform paths that were not verified on Windows or Linux. Review individual changes before reintroducing them. The branch retains its test reports under `apps/desktop/docs/scanner-benchmarks/`.

## Current push

Only the scoped 4K HEVC memory fix, timeline hover/drag previews, and compact controls are retained. Main history is preserved with a corrective commit; it is not reset or force-pushed.

## Verification of the scoped replacement

- Desktop suite: 599 passed, 3 skipped, 1 todo, no failures.
- Rust core suite: 20 passed, 1 ignored, no failures.
- Both TypeScript configurations and all three production builds passed.
- Resolution-gate test and rebuilt plugin signature verification passed.
- Original 4K file: 15-second isolated VideoToolbox check, 448 displayed frames, zero reported lost frames. This was not a full-app memory measurement or a listening test.
- Preview extraction from the original file produced a 320 × 180 image. Hover/drag and cache lifecycle tests passed.
- Lower-resolution playback was not rerun. The compiled gate test and source comparison verify that lower resolutions retain the original decoder conditions.

## Baseline correction

At the user's request, the focused update now uses `v1.0.175`, commit `01e287f3`, as its application baseline. The 1.0.176 memory changes are also excluded. The original scoped update based on 1.0.176 remains available at commit `5c2572c4`. Version 1.0.177 is the pending patched version; the published 1.0.175 tag is unchanged.

After this baseline correction, the desktop suite passed 582 tests with 3 skipped and 1 todo. Both TypeScript configurations and all production builds passed again. The native 4K plugin and preview backend are unchanged from the verified scoped fix.
