# Desktop file and avatar operations

`apps/desktop-tauri/src-tauri/src/desktop_os.rs` handles `shell:open-folder-path`, `shell:show-item`, and `profiles:choose-avatar`. Add `mod desktop_os;` in the Tauri entry point and route those three channels to `desktop_os::handle(&window, &state, &channel, &args).await`.

The two shell channels share the Electron behavior. They trim the supplied local path, reject URL schemes, resolve relative paths, and walk upward when the requested path no longer exists. An existing media file opens its containing folder with the file selected. A directory or the nearest existing ancestor opens in the platform file manager. The return value is `true`.

The Tauri path adds profile checks before the operating-system call. Existing files must pass `Store::authorize_media`, which applies active-profile content access and confirms that the file belongs to an approved library folder. Opening a directory or an ancestor requires an unlocked owner profile because the current core API cannot authorize a missing path or directory against profile content access.

Avatar selection requires an unlocked owner profile before opening the dialog and again before processing the selected file. Cancellation returns `null`. PNG, JPEG, and WebP inputs may be at most 10 MiB. The decoder limits dimensions to 32,768 pixels per side and allocations to 256 MiB. It center-crops the shortest side, resizes the square to 256 by 256 pixels with Lanczos filtering, encodes PNG, and returns a `data:image/png;base64,...` string no longer than 512 KiB.

Add these direct dependencies to `apps/desktop-tauri/src-tauri/Cargo.toml`:

```toml
base64 = "0.22"
image = { version = "=0.25.9", default-features = false, features = ["jpeg", "png", "webp"] }
```

The exact `image` pin matters while the workspace declares Rust 1.85. `image` 0.25.9 supports Rust 1.85, while 0.25.10 requires Rust 1.88.

No new Tauri capability entry is needed. These handlers call the Rust APIs of the dialog and opener plugins that the application already initializes.

`playback:activity` is implemented separately in `playback_activity.rs` because its macOS token and lease timers have application lifetime rather than dialog lifetime.
