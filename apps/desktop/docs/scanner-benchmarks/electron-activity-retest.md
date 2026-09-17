# Catalog retest and live process activity

Recorded September 15, 2026 on macOS ARM64. The live app used its existing library. A separate temporary database contained 50,000 simulated movie records. The two workloads ran concurrently, so CPU contention can affect timing. No application settings, library data or playback controls were changed.

## 50,000-video catalog retest

Three fresh processes per implementation, five reads each. Every read passed count, unique ID, title and playback-reference assertions. Median repeat times exclude each process's first read.

| Measurement | TypeScript | Rust integration |
| --- | ---: | ---: |
| Repeat catalog read | 8.01 ms | 1,891.32 ms |
| First read including cache initialization and worker startup | 1,076.23 ms | 2,980.52 ms |
| Parent peak RSS | 832.77 MiB | 850.67 MiB |
| Worker RSS sampled after responses | 0 MiB | 330.89 MiB |

The tested integration was about 236 times slower for repeat catalog reads. It retained the TypeScript catalog and rebuilt and transferred the Rust result on each request. LoomTV no longer uses this Rust catalog path. The Rust scanner remains active, while Electron reads catalog data through the TypeScript and SQLite path.

## Live app activity

15 macOS `top` observations over 92 seconds. Each observation uses the second interval sample for CPU and `MEM` for process footprint. These are rounded OS values, distinct from the benchmark's RSS measurements. The UI showed a paused player with a Play button and unchanged position at the two UI checks. The agent did not resume or stop it.

| Process | PID | Start MiB | End MiB | Peak MiB | Mean CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Electron main | 33334 | 388 | 374 | 420 | 1.37% |
| Renderer | 33380 | 1,985 | 3,065 | 3,065 | 74.16% |
| Helper | 33336 | 118 | 118 | 118 | 0% |
| Helper | 33337 | 14 | 14 | 14 | 0% |
| Rust core | 33576 | 8.58 | 8.58 | 8.58 | 0% |
| Discovery helper | 33384 | 1.5 | 1.5 | 1.5 | 0% |

The renderer grew by 1,080 MiB during the observation window, while the Rust process stayed flat. This is evidence of continued renderer allocation or retention during the paused-player state. It does not identify the allocation source or prove a particular leak. A renderer heap/allocation profile is needed next.

The small live Rust process and the much larger simulated Rust process are different workloads. The live app did not receive the 50,000 simulated records. Do not compare these numbers as a before/after improvement.

Raw records are `electron-live-activity.json` and `electron-core-50k-retest.json` in this directory. The temporary simulation database was removed and the Electron SQLite addon restored and checked. An initial benchmark attempt exited with code 137 before producing samples; replacing the native addon through a fresh file allowed the recorded run to complete.
