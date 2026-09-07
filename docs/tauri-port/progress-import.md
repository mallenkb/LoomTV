# Progress import

`crates/loomtv-core/src/progress_import.rs` implements the `progress:import` database behavior. The parent module must expose it with `pub mod progress_import;`, and `Store::invoke` must route `progress:import` to `self.import_progress_data(args)`.

The method accepts the existing IPC arguments: a record of file paths to progress values, followed by an optional expected profile ID. A value can be a position number or an object with optional `position`, `duration`, and `updatedAt` numbers. Missing position and duration values become zero. A missing or zero timestamp uses the import time. Fractional timestamps are truncated because the Rust reader expects SQLite integer timestamps.

The active profile check runs before the import. When the optional profile ID differs from the active profile, the existing `stale_profile_selection` error prevents writes. The import uses one SQLite transaction. An existing row changes only when the imported timestamp is newer. Equal and older values leave it untouched. Progress at or above 90 percent is marked watched and stores the duration as its position, matching the Electron repository.

Direct callers are limited to 10,000 entries and 2 MiB of encoded progress data. Paths are limited to 16 KiB and cannot contain a null byte. Numeric values must be finite and within JavaScript's safe integer magnitude. Unknown object fields do not affect the stored row, matching Zod's default object behavior.

This implementation reads and writes only the Tauri `Store` connection supplied by its caller. It does not open an Electron database, read API keys, or access OS credentials.

No database tests or runtime checks were performed while adding this module.
