# 4K scrubbing check, 19 September 2026

## Result

The existing libmpv integration completed the controlled long jumps and rapid preview-request sequences with short engine completion times. This supports using it as a responsive fallback. It does not establish zero visible delay or prove that its scrubbing feels identical to VLC.

| mpv check | Completed samples | Native seek to playback restart |
| --- | ---: | ---: |
| Long jumps while playing | 8 of 8 | 85–102 ms; median 93 ms |
| Long jumps while paused, planned requests | 8 of 8 | 26–75 ms; median 40 ms |
| Final seek after forward preview burst while playing | 1 | 86 ms from release marker |
| Final seek after backward preview burst while playing | 1 | 84 ms from release marker |

The original 3840 × 2160 HEVC Main 10 file used VideoToolbox at 30 fps. The final mpv diagnostic sample reported zero decoder drops and zero display drops. Seek completion is based on mpv's native playback-restart event observed by the app, with its normal polling interval. It excludes pointer input delivery and display scanout. The timeline's optimistic position update was not used as proof of completion.

## Test method

Tests ran against the previously built production assets and a separate copy of the library. A temporary probe recorded native commands and events without modifying the production player. The final repeatable sequence called the same validated main-process command handlers used by the renderer.

Each engine received eight long jumps while playing and eight while paused, visiting one, fifteen, twenty-five, and five minutes. Four preview bursts moved forward and backward between one and fifteen minutes. Each burst sent thirteen positions 80 ms apart, matching the current native preview cadence, then sent the release target. That is 72 planned seek requests per engine.

The mpv playing phases were uninterrupted. Extra non-test requests appeared during the paused phases; only the first eight planned paused jumps are included in the table. The paused burst timings are excluded. During playing bursts, some requests were superseded before a separate restart event, so the data does not prove that every intermediate preview frame appeared.

Separate pointer checks showed changed video frames after backward and forward timeline jumps. The computer-control window capture and drag behavior was unreliable across the full comparison. It did not provide a valid continuous visual recording or a frame-accurate measurement of visible latency. This limitation prevents an assertion that the complete user experience matches VLC exactly.

## VLC comparison

The bundled VLC build completed the same 72-request sequence without a recorded playback error. It failed VideoToolbox initialization for this file and used software HEVC decoding with ten threads. This run did not use the separate experimental VLC VideoToolbox patch.

VLC exposed time updates and cumulative displayed-picture counters. Those signals do not identify the first displayed frame for a specific seek and are not equivalent to mpv's playback-restart event. No VLC versus mpv latency ranking is claimed from them.

## Delivery

No production playback settings, engine order, or source code changed for this test. The installed app and original database were not replaced. Temporary test processes were stopped after collecting results.

The probe, event traces, and analysis are under `/tmp/loom-memory-20260919`, using the names `scrub-probe.cjs`, `scrub-sequence.cjs`, `scrub-sequence-vlc.cjs`, `seek-sequence-mpv-*`, `seek-sequence-vlc-*`, and `scrub-mpv-analysis.json`.
