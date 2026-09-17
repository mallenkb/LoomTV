# Memory inspection, September 16, 2026

The running installed app was LoomTV 1.0.168, PID 42601. Its renderer bundle contained the previous obsolete-transcode cleanup. It did not contain this pass's artwork repository changes.

Six macOS `top` samples were recorded over approximately 30 seconds. A subsequent screenshot showed a paused video. No navigation or playback actions were performed, so this is an observational baseline, not a repeated-use benchmark.

| Process | First MiB | Last MiB | Peak MiB |
| --- | ---: | ---: | ---: |
| Main | 492 | 587 | 587 |
| Renderer | 121 | 122 | 122 |
| GPU | 124 | 124 | 124 |
| Network | 8.81 | 8.88 | 8.88 |

A subsequent two-second macOS `sample` capture reported main-process physical footprint of 384 MiB and lifetime peak of 1.0 GiB. Memory fell after the short capture. These observations do not establish a persistent leak or its cause. OS footprint figures are rounded and are not JavaScript heap measurements.

## Changes

- Cached artwork files are hashed using a buffer of at most 256 KiB instead of loading the whole file into a Buffer. Every byte is still checked against the stored SHA-256 hash and byte count. The file descriptor closes in a finally block.
- Custom artwork rows are validated and added directly to the result map using a database iterator. The intermediate full row array is removed.
- Image quality, cache quotas, preloading, effects, and hardware acceleration are unchanged.

TypeScript checking and diff whitespace checking passed. No automated tests ran. The new changes were not installed into the running app or compared in a runtime benchmark. No whole-app savings percentage is established. Repeated navigation and playback cleanup still need verification.

Raw baseline: `electron-memory-2026-09-16.json`. The separate native stack sample remains at `/tmp/loom-main-sample-0916.txt`.
