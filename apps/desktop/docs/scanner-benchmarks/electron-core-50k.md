# Electron core catalog benchmark

50,000 simulated movie records in a temporary SQLite database. Three fresh processes per implementation, five index reads per process. Both retain the TypeScript host catalog, matching the current integration. Fixture IDs, titles, counts and playback references passed assertions on every read. No real video decoding or provider calls ran.

| Median | TypeScript | Rust integration |
| --- | ---: | ---: |
| Repeat index read | 7.26 ms | 1,702.24 ms |
| First read including host cache load and worker startup | 914.65 ms | 2,939.66 ms |
| Parent process peak RSS | 853.98 MiB | 880.66 MiB |
| Worker RSS sampled after responses | 0 MiB | 330.98 MiB |

The current Rust integration regresses catalog read performance. Repeat reads are about 234 times slower. Rust reconstructs each catalog from SQLite and serializes it through the child-process pipe while the previous path projects the retained host cache. TypeScript still owns the full catalog, so this adds a second process without removing the original data ownership.

This measures catalog processing with identity artwork delivery, not actual artwork capability generation. Rust includes its pipe transfer and schema validation. Renderer IPC, Chromium, GPU memory, image decoding and playback are excluded. Parent peak RSS and sampled worker RSS are different measurements and must not be described as simultaneous whole-app memory. No garbage collection was forced.

Raw results: `electron-core-50k.json`. Runner: `apps/desktop/scripts/benchmark-electron-core.ts`. Temporary database was removed and the Electron SQLite native addon restored after the run.
