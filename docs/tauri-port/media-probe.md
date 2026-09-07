# Media probe service

`loomtv-core/src/probe.rs` replaces the Tauri handler that returned raw FFprobe JSON. `MediaProbe::probe` returns the existing renderer `ProbeResult` shape with normalized tracks, codecs, resolution, duration, bitrate, subtitle streams, disposition flags, color fields, and exact rational frame-rate parsing.

The service accepts only a path authorized by the current Store profile. It captures the active profile and selection revision before probing, then verifies the same profile, revision, source, and canonical path before returning either a new or cached result. A profile change cannot expose probe metadata from the previous selection.

At most two FFprobe processes run at once. Requests for the same canonical path, size, and rounded modification time share one spawned operation. Successful results use a 30-minute LRU cache capped at 128 entries. FFprobe receives a 15-second execution timeout and a 1 MiB stdout limit. Processes use `kill_on_drop`, and shutdown signals active or queued work before waiting briefly for both process permits.

`can_direct_play` matches the existing `mediaProbe.ts` renderer policy: only the `html5` backend can return true, and it requires H.264 video, `yuv420p`, a profile without `10`, and AAC or MP3 audio. The HLS backend returns false.

Wiring requires `pub mod probe;`, a Runtime-owned `MediaProbe::new(ffprobe.clone())`, routing `media:probe` through `probe(store.clone(), source)`, routing `media:can-direct-play` through the normalized result and `can_direct_play`, and calling `shutdown()` during application exit. The old `probe_gate` and raw FFprobe handler can then be removed.

No FFprobe process, media read, application launch, or runtime database access was performed.
