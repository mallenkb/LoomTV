# Desktop port decisions

The implementation scope is the desktop application. The existing Node NAS, mobile, and TV applications retain their source and deployment behavior. Rust crates in this workspace support the desktop application. There is no standalone Rust NAS application.

React remains the renderer. Both desktop shells build the current source in `apps/desktop/src`. The transport-neutral bridge factory preserves the preload method definitions used by the renderer. Moving the UI to `packages/desktop-ui` remains deferred until native behavior has been checked.

The old Tauri branches remain reference material. Their code and parity claims were not imported.

Tauri shares Electron's desktop data directory and SQLite database. The default path comes from the platform configuration directory joined with `LoomTV`, which is `~/Library/Application Support/LoomTV` on macOS. `LOOMTV_DATA_DIR` overrides the directory for controlled development or recovery work. The database filename remains `loomtv.sqlite`.

`Store::open` accepts schema version 14. It creates the frozen version 14 schema only when no database exists. It does not run Electron migrations, upgrade an older database, or downgrade a newer one. A version mismatch stops startup.

For a pre-existing database without `tauri-shared-storage-v1`, startup uses SQLite's backup API to create `backups/loomtv-before-tauri-<timestamp>.sqlite`. Tauri writes the marker only after the backup succeeds. Later starts do not repeat that backup while the marker remains. On Unix, Tauri sets mode `0600` on the live database and this backup. The code does not add a cross-process lock, so simultaneous Electron and Tauri writes have not been accepted as a supported workflow.

Most profile and library data is intentionally shared. Tauri keeps its local profile choice in `device_profile_selections` and `device_profile_selection_revisions` under the device ID `desktop-tauri`. Electron's selection row remains separate. Tauri Guest profiles also use `desktop-tauri` as their guest device ID and are cleared without deleting another desktop shell's Guest row.

Settings stay in the shared `app_settings.data_json` record, including the existing TMDB, OMDb, OpenSubtitles, and related metadata credentials. Tauri does not move settings credentials into the OS keyring. Owner renderer reads retain the existing settings contract. Non-owner reads remove API-key and subtitle-account fields, and every renderer read removes local-network secrets and the legacy `__secretRef` field. Settings writes merge the validated patch into the shared record and remove `__secretRef`, so fields outside the patch survive. The metadata gateway receives the shared settings inside the Rust process and does not accept API keys from its request payload.

The OS keyring is still used for the remote-client pairing session. That use is separate from shared application settings and metadata API keys.

Catalog IPC keeps local playback paths because the desktop renderer uses them as progress and playback references. Artwork fields accept durable non-loopback HTTPS URLs. Saved custom artwork uses a profile-scoped `loomtv://localhost/api/custom-artwork` URL that binds the media ID to the active profile and selection revision. The protocol handler reads only the matching bounded `custom_artwork` record. Arbitrary filesystem paths do not cross the artwork fields.

The loopback media server belongs to the Tauri desktop process. It issues short-lived media grants tied to the active profile revision. It does not replace desktop LAN hosting or the existing NAS API.

LibVLC objects live on one worker thread. The window host owns the drawable on the main thread. Commands use a bounded queue, and stop completes before the host hides the view. JavaScript cannot supply a native pointer.

The macOS host enables Tauri's `macos-private-api` feature for transparent WKWebView rendering. The installed Wry implementation uses WebKit's private `drawsBackground` setting. The AppKit host uses public NSView methods. Distribution and maintenance review remains open, and no App Store suitability is claimed.

Runtime, visual, performance, migration, concurrent-shell, and platform acceptance checks remain open. The user's standing instruction permits tests only when explicitly requested.
