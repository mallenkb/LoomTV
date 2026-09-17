# Further library-loading improvements

This comparison uses the previously optimized row-by-row loader as its baseline, saved before this pass. It measures the additional changes, not the original whole-table loader.

Newly loaded records are normalized in place because the loader owns them. Cast and episode arrays no longer need a second set of records. Fixed validation schemas are constructed once at module initialization instead of repeatedly for each database row. Validation rules and full output remain unchanged.

## Results

The same synthetic database contains 50,000 videos: 10,000 movies and 40,000 episodes across 2,000 shows. Each version ran in three fresh Node processes, in alternating order with a warm filesystem cache.

| Median | Previous optimized loader | New loader | Reduction |
| --- | ---: | ---: | ---: |
| Load time | 666 ms | 261 ms | 60.9% |
| Peak process RSS | 554.3 MiB | 364.7 MiB | 34.2% |
| Retained heap after GC | 64.0 MiB | 63.9 MiB | 0.2% |

All six full output hashes matched. All 12 targeted database repository and scan persistence tests passed. TypeScript and diff checks passed.

RSS includes Node, SQLite, and module loading and is recorded before output serialization. These figures measure temporary loading costs in the synthetic workload, not whole-app Electron memory or playback performance. No production database was modified. The new loader has not been installed in the running app.

Raw results: `library-load-50k-stage3.json`. The intermediate record-copy-only measurement is in `library-load-50k-stage2.json`; it showed a smaller 2.8% median peak RSS reduction before schema reuse was added. The baseline snapshot is `/tmp/loom-library-load-stage1.ts`. Set `LOOM_LIBRARY_BASELINE` to that file when rerunning the benchmark script.
