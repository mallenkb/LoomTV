# Library loading benchmark

Measured on September 16, 2026 using Node 24.15.0 on macOS. The comparison isolates the working-tree row-iteration change against the repository's HEAD version of `databaseLibraryRepository.ts`.

The synthetic database contains 10,000 movies and 2,000 shows with 40,000 episode files, totaling 50,000 videos. It includes episode descriptions, artwork URLs, seasons, cast entries, and a custom-artwork override. No user database was read or changed.

Three fresh processes ran each version in alternating order against the same database. Results below are medians. Filesystem cache was warm; this was not a cold-disk benchmark.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Load time | 645 ms | 607 ms | 5.9% |
| Peak process RSS | 630.2 MiB | 554.5 MiB | 12.0% |
| Retained JavaScript heap after GC | 64.0 MiB | 63.5 MiB | 0.8% |

Peak RSS includes Node, SQLite, and module loading. It was recorded before result serialization. Explicit garbage collection ran before loading and after measurement. Timing ranges overlap: before 588–683 ms; after 598–608 ms. The small timing improvement needs more repetitions to establish its consistency.

All six complete library outputs had identical SHA-256 hashes. The targeted database repository and scan persistence suites passed all 12 tests.

This change reduces temporary allocations during full-library loading. It does not establish a 12% reduction in overall Electron memory, idle memory, or video-playback memory. It does not measure the earlier artwork changes or reproduce the previous renderer spike.

Raw measurements are in `library-load-50k.json`. Run `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/benchmark-library-load.ts docs/scanner-benchmarks/library-load-50k.json` from `apps/desktop` with a Node-compatible better-sqlite3 binary. The baseline is taken from HEAD, so comparisons after committing the optimization require updating the baseline reference.
