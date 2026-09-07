# Desktop segment repository

`loomtv-core/src/segments.rs` implements the schema 14 portion of the Electron segment IPC contract.

Supported channels:

- `playback:segments:get`
- `playback:segments:save-manual`
- `playback:segments:delete-manual`
- `playback:segments:undo-manual`
- `playback:segments:manage-list`
- `playback:segments:manage-update`
- `playback:segments:manage-erase`
- `playback:analysis:status`

Manual writes and management commands require the active owner profile. Reads require an active profile and apply the existing content policy. The implementation keeps the Electron candidate priority, credits handling, manual history, managed row shape, and segment revision hash. Candidate updates preserve `analysisMetadata.userDecision`.

The core derives file revisions only when stored local metadata contains a positive `durationSeconds` value. Missing duration metadata returns `segment_probe_required`; the core does not pretend that an unprobed file has no segments. The Tauri host should route the file through its media probe and persist the resulting local metadata before retrying.

Manual candidates currently omit `releaseKey` because computing it reads media contents. They remain attached to the exact file revision but cannot be reassociated automatically after the file identity changes.

Local fingerprint and video analysis are not implemented. `playback:analysis:status` reports `unavailable` when the feature is enabled and `disabled` when settings disable it. Analysis run, season, cancel, pause, resume, cleanup, and rebuild channels return `segment_analysis_unavailable` after owner authorization.

Wiring requires adding `mod segments;` in `loomtv-core/src/lib.rs` and forwarding the channels above from `Store::invoke` to `Store::segments_invoke`. The module uses the existing `chrono`, `rusqlite`, `serde`, `serde_json`, and `sha2` dependencies; no new crate is required.

Runtime analysis, media probing, and database mutation were not performed.
