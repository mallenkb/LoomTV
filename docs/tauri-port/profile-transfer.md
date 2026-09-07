# Desktop profile transfer

The Rust desktop port uses the existing `loomtv.profile.v1` JSON format. The core implementation lives in `crates/loomtv-core/src/profile_transfer.rs`. The native file picker wrapper lives in `apps/desktop-tauri/src-tauri/src/profile_transfer.rs`.

`Store::export_profile_data(profile_id)` returns the portable bundle. It requires an unlocked Owner profile and rejects Guest profiles. The bundle contains profile display metadata, playback progress, track choices, profile preferences, restrictions, and personal lists. It does not read or export PIN hashes, PIN salts, provider credentials, tokens, plugin secrets, or application settings.

`Store::import_profile_data(bundle)` validates the complete bundle before opening a transaction. It applies the 25 MB serialized limit, the 100,000-entry limits, and the field bounds used by the Electron implementation. It also requires an unlocked Owner profile and enforces the 10-profile limit. An imported Owner bundle becomes a Standard profile. Kids bundles remain Kids profiles. Guest bundles are rejected.

The import transaction creates the profile without a PIN and copies only data that applies to the current library. Progress entries need a matching movie or episode file path. List entries need a current media ID, except for `discover:` watched entries. Restriction folder paths must match a current library root. Any invalid folder or database error rolls back the whole profile. The result reports imported and skipped progress and list counts through the existing `ProfileTransferResult` fields.

The Tauri wrapper exposes these functions for the main command router:

```rust
profile_transfer::export_profile(&window, &state, profile_id).await
profile_transfer::import_profile(&window, &state).await
```

The parent module must declare `mod profile_transfer;` and route `profiles:export` and `profiles:import` before the generic blocking store dispatch. After a successful import, it should emit the existing `loomtv:profiles:changed` event. Cancellation returns `{ "ok": false }`; transfer failures return `{ "ok": false, "error": "..." }`, which matches the renderer contract.

This code uses dependencies already present in the workspace: `serde_json`, `rusqlite`, `uuid`, `regex`, `tokio`, `tauri`, and `tauri-plugin-dialog`. It needs no database migration or new dependency.
