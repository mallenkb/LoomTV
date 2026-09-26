# Electron scanner

Status: the scanner and memory/performance follow-ups are implemented for Electron. TypeScript remains the default for full discovery. Eligible unchanged quick scans use a compatible bundled Rust worker for a signature check. Full Rust discovery is available for explicit use and benchmarking.

## Scope

The Electron scanner has its own Rust crate at `native/scanner`, including an independent Cargo workspace and lockfile. The worker receives an approved root, file extensions and the current filename-year cutoff. It does not receive credentials, open the catalog or modify media.

TypeScript still owns media IDs, classification, probe precedence, metadata providers, artwork, reconciliation and catalog writes. Both discovery engines expose filename hints, subtitle association keys and local file facts through the inventory. TypeScript now computes hints when classification or subtitle matching requests them. Cache checks and file validation read only file facts. Rust continues to supply hints in its discovery messages. TypeScript joins those keys into one lookup per directory; it does not reread a directory or compare every subtitle with every video. Rust calculates the complete folder signature before reporting completion. The existing subtitle prefix collision was corrected: episode 1 no longer matches episode 10, and matching ignores case.

Discovery inventories stay in memory up to 4,096 entries or a conservative 4 MiB bound. Larger inventories spill to an attempt-local SQLite file with a 2 MiB page cache. Directory paths are stored once, with at most 512 cached directory IDs. Temporary inventory writes skip disk synchronization because failed attempts are discarded. Catalog durability settings are unchanged. Closing an inventory clears its retained records and statements. Staged MediaItems always use SQLite. Episode probes process at most 128 pending candidates at a time and retain only the required output. Delta planning avoids repeated catalog arrays and ownership checks for unchanged items. Bulk checkpoint writes share one transaction; standalone item writes retain their own rollback boundary. Root results are published after their database transaction commits. The catalog remains in better-sqlite3 with its existing configuration. Changed items use upserts; retained child rows are reconciled without replacement. Unchanged items and unrelated roots are not rewritten. Scans never modify configured folder rows. Automatic skip-segment cleanup uses only confirmed file removals inside the same catalog transaction. Unrelated orphans and manual segments are retained.

Checkpoint normalization reuses already normalized records from the committed catalog. Incoming records still copy their artwork fields. Queued artwork jobs now retain normalized URL lists instead of copied catalogs; later catalog edits cannot change those lists. Finalization applies metadata locks once and skips records already shared with committed state. Inventory directory entries share methods instead of allocating methods for each file. Metadata reconciliation maps are built only when a root needs processing. Reused items retain their identity when their category is unchanged.

Scan generations and the active desktop profile are checked before checkpoint publication. Folder mutations cancel active discovery. A failed root discards its results and retains its previous items/cache. Overlapping roots use the most specific configured owner. Graphs whose files belong to several configured roots are conservatively retained instead of allowing one root to remove their child records.

## Scan entry points

Startup and periodic quick scans originate in `src/contexts/LibraryContext.tsx` and use `library:scan`. Manual quick, metadata and full scans use the same IPC handler. `library:add-folder`, `library:add-folder-path` and `library:update-folder` authorize settings changes, update folder configuration and queue a quick scan. All call `scanLibrary` in `src/main.ts`, which selects one engine per root attempt. Initial setup calls that coordinator directly.

Each completed root goes through `saveLibraryScanCheckpoint` and the repository delta transaction. `saveLibraryFromScan` uses the same checkpoint operation for finalization. The non-scan full-save function remains available for folder mutations and other existing callers.

## Development and rollback

From `apps/desktop`:

```sh
node scripts/build-scanner.cjs
LOOM_SCANNER_ENGINE=typescript pnpm start
LOOM_SCANNER_ENGINE=rust pnpm start
LOOM_SCANNER_ENGINE=auto pnpm start
```

The default full-discovery engine is `typescript`. Before discovering a root, eligible quick scans try a Rust signature check and fall back to ordinary discovery if the worker is unavailable or lacks that capability. Setting `LOOM_SCANNER_ENGINE=typescript` explicitly bypasses the native check. `rust` reports worker failures. `auto` retries a failed worker attempt once with TypeScript, after discarding its staging database. Filesystem failures and cancellation do not trigger a language fallback. Set the engine to `typescript` to roll back discovery without reverting the database improvements.

Production resolves the binary from `process.resourcesPath/scanner/<platform>-<arch>/loom-scanner`, with `.exe` on Windows. Development uses the app's resources directory. No installed application needs Cargo or PATH lookup. Forge and electron-builder compile and copy the matching worker before code signing. Cross compilation needs the Rust target and the corresponding system linker. The build script installs cross targets through rustup; it does not supply Linux cross linkers or Windows SDKs.

## Protocol and filesystem policy

Protocol v2 uses newline-delimited UTF-8 JSON. `native/scanner/protocol-contract.json` owns the protocol version, required fields, message kinds and size limits for both implementations. Shared command fixtures run through both validators. The parent validates commands and events; Rust rejects missing or irrelevant command fields, unsafe sequence values, stale request IDs and incompatible versions. Each process handles one root attempt with a unique request ID. It handshakes before discovery, emits progress every 64 directories and acknowledges each validated batch. The additive `fingerprint` command uses the same filesystem and signature rules but emits no entry batches. The parent checks that capability before requesting it; older workers fall back to ordinary discovery. Cancellation and shutdown are commands; cancellation has its own terminal event. Batches contain at most 128 entries and frames at most 256 KiB. Rust keeps one batch in flight. stdout carries only protocol messages; stderr is drained without accumulating logs.

App quit and update installation wait for scanner shutdown before exiting. New scans are rejected while the app closes. The client handles chunk boundaries, rejects malformed/oversized frames and stale sequences, and reaps workers after failures or shutdown. Startup has a 15-second deadline and worker inactivity a 60-second deadline. Startup, inactivity and shutdown deadlines are configurable. The shutdown grace period defaults to two seconds, followed by SIGKILL. Timeouts interrupt blocked batch consumers and reap workers that ignore SIGTERM. Cancellation after completion output still invalidates the attempt. Returned paths must remain within the approved logical root. Symlinked directories are not traversed; file symlinks retain the prior logical-path policy. Unrepresentable UTF-8 names fail discovery.

Sizes and modification times cross JSON as decimal strings. Times are integer milliseconds truncated toward zero. The `inventory-v1` signature sorts logical relative paths by native UTF-8 byte order, normalizes separators to slashes, and hashes each JSON tuple of relative path, size and time followed by a newline. Both engines use the same coverage and ordering. Rust sorts at most 8,192 records or 4 MiB at a time, spills sorted runs to temporary files, and merges at most 32 runs at once. Cancellation is checked during merging and hashing. Auxiliary folders remain in signature coverage even where media classification excludes them. This is a change heuristic, not content hashing. Cache version 16 intentionally causes one rescan; media IDs do not change.

## Native repeat scans

A quick scan validates a root with the additive Rust `inspect` command and its saved signature. It enumerates and stats every supported file, including subtitles and artwork, and computes the same sorted signature. During traversal it saves compact file facts in an anonymous temporary file. A matching signature skips filename hints, entry batches, acknowledgement traffic and the parent's temporary inventory. The scan reuses committed items only when the signature and file count match, cache version/provider settings are current, metadata remains fresh, item counts agree and saved media paths stay inside the root. Catalog inconsistencies, full scans and metadata scans take the ordinary path. Cancellation, disconnected folders and profile/generation changes still prevent publication.

A changed root replays the saved facts through bounded, acknowledged batches into the parent's inventory. It does not traverse the library again. Empty changed roots return an empty inventory. Temporary storage closes on completion, cancellation or failure. Inspection sorts at most 2,048 records per run, while ordinary discovery retains its 8,192-record limit. The worker still needs temporary RAM, and writing saved facts adds disk work. Older workers without `inspect` support fall back to ordinary discovery. Initial scans have no reusable cache and skip inspection. Full Rust discovery remains optional.

The preceding signature-only benchmark has 120 samples: five fresh processes per size, phase and engine. It uses canonical media IDs, the production cache eligibility guard, immediate probe/provider responses and real SQLite writes. Repeat samples follow one unmeasured full scan on recently created local files. The table compares TypeScript repeat scans with that earlier native quick path.

| Files | TypeScript repeat ms | Native quick repeat ms | Time decrease |
| ---: | ---: | ---: | ---: |
| 1,000 | 11.9 | 8.5 | 28.7% |
| 10,000 | 101.9 | 40.2 | 60.5% |
| 50,000 | 527.5 | 167.7 | 68.2% |

The half-time target is met at 10,000 and 50,000 files. At 50,000 files, the native worker uses about 4 MiB. Median combined peak RSS is 238.5 MiB versus 234.1 MiB for TypeScript, a 1.8% increase. One native sample reached 308.1 MiB. Process peak RSS includes the unmeasured initial scan, and no forced garbage collection is used. These measurements establish faster repeat scans, not a further memory reduction or whole-app performance on cold disks and network shares.

The raw samples are in `scanner-benchmarks/pipeline-native-quick-macos-arm64.json`. `summary-native-quick-macos-arm64.json` records medians, min/max spread and comparisons. Earlier measurements below remain available to separate the preceding memory and speed changes from this native path.

The reusable inspection follow-up has 90 samples, five per size, phase and engine. It compares the previous signature-only path with inspection under the same production cache guard. The changed phase modifies one fixture file after a completed scan. Probe and provider responses remain controlled, so these are local scan-and-commit measurements.

| Files | Phase | TypeScript ms | Previous native ms | Inspection ms |
| ---: | --- | ---: | ---: | ---: |
| 1,000 | Unchanged | 12.4 | 9.3 | 10.3 |
| 1,000 | Changed | 20.6 | 28.3 | 24.4 |
| 10,000 | Unchanged | 102.2 | 45.0 | 44.3 |
| 10,000 | Changed | 206.5 | 236.0 | 185.5 |
| 50,000 | Unchanged | 526.6 | 175.3 | 192.4 |
| 50,000 | Changed | 948.6 | 1,124.0 | 857.5 |

At 50,000 files, inspection reduces changed-scan time by 23.7% against the previous native path and reduces filesystem stat calls from 100,002 to 50,001. Unchanged scans remain 63.5% faster than TypeScript, but take 17.1 ms longer than the previous signature-only check. At 1,000 files, changed inspection remains slower than TypeScript by 3.8 ms. Avoiding the second traversal does not remove worker startup, serialization or temporary disk costs.

The 50,000-file unchanged worker median falls from 4.28 to 3.64 MiB, a 15.0% reduction. Combined process peaks remain about 236.8 MiB for both native paths. Changed-scan combined peaks increase from 308.2 to 311.9 MiB. This pass does not establish a total memory reduction. Peaks include warmup and are summed across processes, not measured simultaneously. The raw samples are in `scanner-benchmarks/pipeline-reusable-inspection-macos-arm64.json`.

The follow-up passed 41 scanner tests and three Rust tests. Coverage includes matching, changed and emptied roots, missing-worker fallback, replay after renaming the scanned fixture, and cancellation during replay. Interactive Electron playback was not verified.

Other memory work in this pass removes full catalog snapshots from the artwork queue and avoids building reconciliation maps for unchanged scans. The next areas to profile are decoded poster/background images and active renderer detail data. Existing limits already bound the shared probe cache to 24 MiB and inactive query data to an estimated 8 MiB. Lowering those limits needs cache-hit measurements because eviction can add probe or provider work. These remaining areas were inspected but not measured or rewritten in this pass.

## Measurements

Baseline source: `cd042e2ace4e2661ecb8cf65273e120adca8caf1`.

Measurements were taken on macOS ARM64. Hardware and Node version are recorded in `scanner-benchmarks/summary-second-pass-macos-arm64.json`. The discovery-only table below records the first memory pass. The scan-and-commit table and following comparisons record the second pass before the native quick path. Each sample used a fresh Node process and recently created local fixtures. `first` means the first traversal in that process; `repeat` follows one unmeasured traversal. Neither phase measures a cold disk cache. Five repetitions were interleaved across engines and phases at each size. Probes were controlled functions, with no provider traffic or persistence in this discovery benchmark. The baseline includes its signature walk and original episode collection. New engines include inventory construction, signature generation and episode collection.

Memory is a conservative sum of each process's peak RSS, not the simultaneous combined peak. Benchmarks do not force garbage collection. Numbers do not establish performance on external or network drives, total application memory or a complete Electron scan with real provider latency.

| Files | Phase | Engine | Discovery median ms | Local scan median ms | Local scan min to max ms | Event-loop p95 median ms | Memory upper bound MiB |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | first | baseline | 16.9 | 50.2 | 49.8 to 50.3 | 11.1 | 120.7 |
| 1,000 | first | typescript | 27.9 | 33.0 | 32.5 to 33.6 | 17.2 | 122.4 |
| 1,000 | first | rust | 27.9 | 33.4 | 33.3 to 33.9 | 19.3 | 129.5 |
| 1,000 | repeat | baseline | 10.3 | 42.7 | 41.6 to 47.6 | 10.1 | 121.4 |
| 1,000 | repeat | typescript | 14.5 | 18.1 | 17.9 to 18.6 | 11.0 | 123.7 |
| 1,000 | repeat | rust | 15.6 | 19.4 | 19.3 to 19.8 | 11.0 | 130.4 |
| 10,000 | first | baseline | 109.5 | 471.4 | 468.8 to 477.2 | 10.1 | 140.1 |
| 10,000 | first | typescript | 157.6 | 224.6 | 221.5 to 229.9 | 15.9 | 146.0 |
| 10,000 | first | rust | 131.1 | 200.8 | 199.6 to 204.4 | 15.0 | 152.4 |
| 10,000 | repeat | baseline | 103.6 | 464.2 | 460.2 to 467.2 | 10.2 | 147.2 |
| 10,000 | repeat | typescript | 133.3 | 196.8 | 194.9 to 197.5 | 11.2 | 152.8 |
| 10,000 | repeat | rust | 110.7 | 174.1 | 172.4 to 175.8 | 11.3 | 157.7 |
| 50,000 | first | baseline | 514.6 | 2,363.7 | 2,318.8 to 2,371.3 | 10.1 | 193.3 |
| 50,000 | first | typescript | 711.7 | 1,039.5 | 1,029.2 to 1,050.0 | 10.6 | 193.8 |
| 50,000 | first | rust | 553.4 | 882.8 | 876.9 to 891.5 | 11.1 | 198.9 |
| 50,000 | repeat | baseline | 495.0 | 2,340.9 | 2,338.8 to 2,351.1 | 10.2 | 278.1 |
| 50,000 | repeat | typescript | 687.0 | 1,010.3 | 998.8 to 1,025.2 | 11.0 | 221.2 |
| 50,000 | repeat | rust | 533.9 | 852.1 | 840.0 to 859.2 | 10.9 | 203.7 |

For 50,000 fixture files, new discovery enumerates 251 directories and makes 50,001 initial stat calls. The original signature plus episode/subtitle collection reads directories 25,502 times on that fixture. The in-memory inventory spills to an attempt-local SQLite file above 4,096 entries or the 4 MiB bound. Spill tests cover lookup, hints, byte ordering, filesystem-root paths and eviction of directory lookups. Probe validation may add targeted stat rechecks during a real scan. Production diagnostics separately count probe requests, actual ffprobe executions and probe-cache hits, provider calls, discovery time, checkpoint writes and a conservative parent-plus-child peak RSS bound.

The second-pass controlled scan-and-commit benchmark uses the same fixture design and five fresh-process samples per engine and phase, with 90 samples across 1,000, 10,000 and 50,000 files. It includes real SQLite migrations and catalog writes, with fixed immediate provider responses and synthetic probe results. First scans start with an empty catalog; repeat scans follow one completed scan. These timings stop at catalog persistence and exclude remote provider waits, Electron rendering and app startup. First scans make 500, 5,000 and 25,000 provider calls and the same number of probe calls at the three sizes; repeat scans make none. The pipeline benchmark now closes the temporary inventory before persistence, matching the coordinator. The earlier benchmark kept it open until after persistence, so comparisons to the earlier optimized results also include that measurement correction.

| Files | Phase | Engine | Scan-and-commit median ms | Min to max ms | Persistence median ms | Memory upper bound MiB | Catalog rows changed |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | first | baseline | 60.1 | 59.6 to 61.2 | 2.8 | 134.5 | 502 |
| 1,000 | first | typescript | 35.1 | 33.9 to 35.5 | 4.8 | 135.0 | 501 |
| 1,000 | first | rust | 36.3 | 35.4 to 42.5 | 4.8 | 141.0 | 501 |
| 1,000 | repeat | baseline | 13.4 | 13.3 to 14.0 | 2.9 | 134.7 | 1,004 |
| 1,000 | repeat | typescript | 12.6 | 12.1 to 12.7 | 0.1 | 137.4 | 0 |
| 1,000 | repeat | rust | 15.6 | 15.2 to 15.6 | 0.1 | 142.5 | 0 |
| 10,000 | first | baseline | 515.7 | 496.1 to 518.6 | 25.8 | 159.0 | 5,002 |
| 10,000 | first | typescript | 239.3 | 236.8 to 240.6 | 34.2 | 161.2 | 5,001 |
| 10,000 | first | rust | 233.6 | 231.2 to 252.8 | 34.0 | 167.2 | 5,001 |
| 10,000 | repeat | baseline | 128.8 | 127.9 to 130.9 | 28.6 | 166.1 | 10,004 |
| 10,000 | repeat | typescript | 103.9 | 102.6 to 107.6 | 0.1 | 163.0 | 0 |
| 10,000 | repeat | rust | 105.7 | 104.9 to 110.6 | 0.1 | 170.8 | 0 |
| 50,000 | first | baseline | 2,529.7 | 2,514.4 to 2,544.5 | 126.8 | 292.9 | 25,002 |
| 50,000 | first | typescript | 1,137.7 | 1,113.1 to 1,155.6 | 176.8 | 229.8 | 25,001 |
| 50,000 | first | rust | 1,051.8 | 1,046.7 to 1,062.0 | 172.4 | 236.4 | 25,001 |
| 50,000 | repeat | baseline | 655.3 | 648.8 to 685.6 | 155.2 | 316.7 | 50,004 |
| 50,000 | repeat | typescript | 549.7 | 530.0 to 606.0 | 0.1 | 231.7 | 0 |
| 50,000 | repeat | rust | 515.5 | 508.1 to 538.1 | 0.1 | 236.5 | 0 |

The earlier persistence-only benchmark used real local SQLite files and predates both memory follow-ups. An unchanged 50,000-item save took a median 872.5 ms through replacement and 251.1 ms through delta planning/persistence. Replacement changed 100,002 rows; the delta changed zero. That timing includes cloning and comparison.

The second-pass 50,000-file scan-and-commit benchmark measures TypeScript at 229.8 MiB on first scans and 231.7 MiB on repeat scans. Those are 21.6% and 26.9% lower than the original scanner rerun in the same benchmark. First scans take 1,137.7 ms versus 2,529.7 ms, 55.0% faster. Repeat scans take 549.7 ms versus 655.3 ms, 16.1% faster. The repeat-scan slowdown from the first memory pass is resolved on these fixtures. The smaller workloads do not show uniform memory reductions.

To isolate this second pass from run-to-run fixture and garbage-collection variation, a separate comparison used the saved pre-pass TypeScript discovery and inventory on the same 50,000-file fixture. Five interleaved samples per phase show first scans falling from 1,328.1 to 1,203.9 ms, 9.4% faster, and repeat scans falling from 730.1 to 555.1 ms, 24.0% faster. Peak RSS is essentially unchanged: 227.2 to 227.7 MiB for first scans and 228.5 to 230.1 MiB for repeat scans. This comparison excludes the Electron checkpoint's artwork normalization. It does not establish an additional scan-process memory reduction from this pass.

A separate benchmark measures artwork normalization before checkpoint delta planning. It uses 50,000 committed records and 50,000 incoming records, with identical setup and five interleaved fresh-process samples per version. Reusing committed records reduces median peak RSS from 252.3 to 214.6 MiB, a 14.9% decrease. Normalization takes 30.6 ms versus 43.5 ms, 29.7% faster. All 50,000 committed records retain their identity; incoming snapshots still copy. Peak RSS includes fixture creation. This benchmark excludes discovery, database writes, providers and Electron rendering. Its percentage must not be added to the scan benchmark or presented as whole-application memory savings.

Raw data lives in `scanner-benchmarks/pipeline-second-pass-macos-arm64.json`, `second-pass-comparison-macos-arm64.json` and `projection-second-pass-macos-arm64.json`. That pass has its own summary, `summary-second-pass-macos-arm64.json`; it records medians, min/max spread and percentage changes. The original and first memory-pass artifacts remain available as historical measurements.

Full Rust discovery remains opt-in. At 50,000 files, its scan-and-commit memory is 236.4 MiB on first scans and 236.5 MiB on repeat scans, 19.3% and 25.3% lower than the original scanner. Its latest discovery advantage over TypeScript is below the 20% promotion threshold. Other platform package checks remain open. Full provider-bound scan performance and external/network-drive measurements remain unverified.

Remaining costs include filesystem stats, inventory writes and signature ordering, changed-item checkpoint writes, media probes on uncached files and waits for metadata providers. The local fixture does not measure provider latency. The separate persistence benchmark measures unchanged saves. The controlled scan-and-commit benchmark also records changed-root write volume, but does not exercise real metadata providers or the full Electron coordinator.

## Changed files

Discovery and protocol live in `src/main/scanning/` and `native/scanner/`. The scan coordinator and catalog writes changed in `src/main.ts`, `src/main/databaseLibraryRepository.ts`, `src/main/databaseSegmentsRepository.ts`, `src/main/database.ts` and `src/main/ipcHandlers.ts`. Inventory consumers changed in `src/main/libraryScanFiles.ts`, `src/main/libraryScanner.ts`, `src/main/libraryScanConcurrency.ts`, `src/main/mediaProbeFile.ts`, `src/main/metadataItemBuilders.ts`, `src/main/artworkFinders.ts` and `src/main/fileClassification.ts`. Committed artwork normalization changed in `src/main/libraryProjections.ts`. Build and runtime checks changed in `forge.config.ts`, `package.json`, `scripts/build-scanner.cjs`, `scripts/ensure-update-config.cjs`, `scripts/verify-scanner.cjs` and `scripts/verify-packaged-runtime.cjs`. The benchmark scripts are `scripts/benchmark-scanner.ts`, `scripts/benchmark-scan-pipeline.ts`, `scripts/benchmark-scan-persistence.ts` and `scripts/benchmark-scan-projection.ts`.

## Verification

Executed locally:

- Latest follow-up: 63 affected tests passed, with no failures or skips. Coverage includes lazy filename hints before and after inventory spilling, unchanged signatures, committed record reuse and independent snapshots, bounded episode processing, probe failures, transactional rollback, and valid-video ffprobe integration for both engines. Native signature checks cover changed files, additions, removals, stale metadata, cross-root paths and older worker fallback. URL-only artwork snapshots preserve normalization and remain independent of later edits.
- Latest desktop TypeScript check and lint for the changed runtime, test and benchmark files: passed.
- Latest Electron main production build and renderer-binding verification: passed. The compatible Electron SQLite module was restored and its runtime load check passed after Node benchmarks.
- Latest measurements comprise 120 native quick-path scan-and-commit samples. The preceding pass recorded 90 scan-and-commit samples, 20 paired previous/current samples and 10 artwork-normalization samples. Catalog row counts, calls, memory, timings and spread are recorded in the new artifacts. The 180 samples from the first memory pass remain available.

The latest macOS ARM64 resource worker was rebuilt. Its handshake, full discovery, signature-only command and cancellation passed the runtime verifier. Three Rust unit tests passed.

Earlier implementation checks, before the memory follow-up:

- Existing scan baseline: 9 tests passed before implementation.
- Earlier full desktop suite: 512 passed, 0 failed, 1 skipped, 1 TODO across 514 tests, including the real-media fixture, ownership, row-identity, stale-generation, profile-change, early-worker-exit, shutdown, protocol and inventory-spill cases.
- Before the memory follow-up, affected TypeScript tests: 41 passed, 0 failed, 0 skipped. The three lifecycle tests were rerun successfully after wiring awaited shutdown into app quit and update installation. This includes the latest signature, subtitle lookup, memory-bound inventory, worker deadline and transactional segment cleanup changes.
- Rust unit tests: 3 passed, covering shared protocol fixtures, signature spill/merge ordering and merge cancellation.
- Dedicated FFmpeg/ffprobe integration: passed for both engines using a generated valid video.
- Desktop and build-config TypeScript checks: passed.
- Lint for changed runtime, test and build files: passed.
- macOS ARM64 Rust release build: passed.
- macOS ARM64 electron-builder package: passed with ad-hoc signing. Its bundled worker passed handshake, discovery, signature and cancellation checks, plus packaged-runtime and strict app/worker code-signature verification.
- macOS ARM64 Forge package: passed after correcting the MPV resource check and retaining its in-process `mpv/lib` payload during pruning.
- Worker copied into the macOS app bundle: handshake, small discovery, signature verification and cancellation passed. The packaged-runtime checks and strict code-signature verification of both the app bundle and scanner passed.

The macOS packages listed above were verified before the memory follow-up and have not been rebuilt with it. Windows, Linux, Intel macOS, external/network drives, provider-bound scans and interactive Electron scan flows have not been verified here. A Developer ID notarized release was not produced. Keep the default engine unchanged until its promotion gates and the remaining platform checks pass.

Commands used from the repository root:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/desktop/tests/libraryScanFiles.test.ts apps/desktop/tests/libraryScanner.test.ts
LOOM_TEST_FFMPEG=/opt/homebrew/bin/ffmpeg LOOM_TEST_FFPROBE=/opt/homebrew/bin/ffprobe node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/desktop/tests/*.test.ts
LOOM_TEST_FFMPEG=/opt/homebrew/bin/ffmpeg LOOM_TEST_FFPROBE=/opt/homebrew/bin/ffprobe node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/desktop/tests/scanner*.test.ts apps/desktop/tests/libraryScanFiles.test.ts apps/desktop/tests/libraryScanner.test.ts
node apps/desktop/scripts/benchmark-scanner.ts apps/desktop/docs/scanner-benchmarks/discovery-memory-macos-arm64.json
node apps/desktop/scripts/benchmark-scan-pipeline.ts apps/desktop/docs/scanner-benchmarks/pipeline-memory-macos-arm64.json
node apps/desktop/scripts/benchmark-scan-persistence.ts
cargo fmt --check --manifest-path apps/desktop/native/scanner/Cargo.toml
cargo build --locked --release --manifest-path apps/desktop/native/scanner/Cargo.toml
node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json
node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.node.json
cd apps/desktop
corepack pnpm run lint
corepack pnpm run build:main
node scripts/run-electron-forge.cjs package --arch=arm64
node scripts/verify-scanner.cjs out/LoomTV-darwin-arm64/LoomTV.app/Contents/Resources/scanner/darwin-arm64/loom-scanner
node scripts/verify-packaged-runtime.cjs
CSC_IDENTITY_AUTO_DISCOVERY=false corepack pnpm exec electron-builder --mac --arm64 --dir --publish=never
node scripts/verify-packaged-runtime.cjs out/builder/mac-arm64
codesign --verify --deep --strict out/builder/mac-arm64/LoomTV.app
codesign --verify --strict out/builder/mac-arm64/LoomTV.app/Contents/Resources/scanner/darwin-arm64/loom-scanner
codesign --verify --deep --strict out/LoomTV-darwin-arm64/LoomTV.app
codesign --verify --strict out/LoomTV-darwin-arm64/LoomTV.app/Contents/Resources/scanner/darwin-arm64/loom-scanner
```

The normal application startup rebuilds better-sqlite3 for Electron. The process lifecycle uses asynchronous spawning and explicit closure, following [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance) and the [Node child-process contract](https://nodejs.org/api/child_process.html).

Latest follow-up commands from the repository root:

```sh
node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json
corepack pnpm --dir apps/desktop exec eslint src/main.ts src/main/artworkCache.ts src/main/database.ts src/main/databaseArtworkRepository.ts src/main/libraryProjections.ts src/main/scanning/inventory.ts src/main/scanning/typescriptDiscovery.ts src/main/scanning/discover.ts src/main/scanning/quickScanCache.ts src/main/scanning/rustScannerClient.ts scripts/benchmark-scan-pipeline.ts scripts/benchmark-scan-projection.ts scripts/verify-scanner.cjs
node apps/desktop/scripts/benchmark-scan-pipeline.ts apps/desktop/docs/scanner-benchmarks/pipeline-native-quick-macos-arm64.json
node apps/desktop/scripts/benchmark-scan-projection.ts apps/desktop/docs/scanner-benchmarks/projection-second-pass-macos-arm64.json
node apps/desktop/scripts/build-scanner.cjs
node apps/desktop/scripts/verify-scanner.cjs apps/desktop/resources/scanner/darwin-arm64/loom-scanner
node apps/desktop/scripts/ensure-electron-natives.cjs
corepack pnpm --dir apps/desktop run build:main
```
