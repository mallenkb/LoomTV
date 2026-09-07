# Playback sleep inhibition

`apps/desktop-tauri/src-tauri/src/playback_activity.rs` owns the display sleep inhibitor for the Tauri desktop process. Add `mod playback_activity;` in the Tauri entry point and add a `playback_activity: playback_activity::PlaybackActivity` field to `Runtime`. Construct it with `playback_activity::PlaybackActivity::new()?` before managing the runtime.

Route `playback:activity` by reading the current settings without holding the store lock across the activity call:

```rust
let timeout_minutes = {
    let store = state.store.lock().await;
    playback_activity::configured_timeout_minutes(&store.settings()?)
};
state.playback_activity.handle(&args, timeout_minutes).await
```

The handler keeps the existing `[key, active, label?] -> true` bridge contract. Keys are trimmed like the Electron activity governor. A first active call creates a lease, and an inactive call removes it. The service holds one operating system activity while any unexpired lease remains. It caps the map at 64 distinct keys and reports an error when that limit or its bounded command queue is full.

The timeout follows `nativePlaybackPower.ts`. Zero keeps the display awake until the lease is released. A positive timeout expires the lease after that many minutes. Repeating an active call for an existing key does not extend its deadline. If the configured timeout differs from the value on existing leases, all lease timers restart with the new setting. Call `refresh_timeout` after a settings save if the new timeout must apply immediately while no activity IPC call is occurring.

On macOS, a dedicated owner thread creates and ends an `NSProcessInfo` activity with `NSActivityIdleDisplaySleepDisabled`. The Objective-C activity token never leaves that thread. The only unsafe operation ends the exact token returned by Foundation. The existing `objc2 = "0.6"` and `objc2-foundation = "0.3"` dependencies are sufficient because the latter currently uses its default features. If its default features are disabled later, enable `NSProcessInfo` and `NSString`.

Other platforms return `unsupported_platform` from activity and timeout refresh calls. They do not report successful inhibition.

Call `state.playback_activity.shutdown().await` from `begin_shutdown` before `app.exit(0)`. Shutdown clears every lease, ends the macOS activity, and joins the owner thread. `release_all` provides the same cleanup while leaving the service ready for later activity. `Drop` is a final synchronous safeguard, but the explicit shutdown call is the normal ownership path.

The service bounds IPC replies to five seconds. A stopped, overloaded, or failed owner thread returns an error instead of claiming that sleep inhibition succeeded.

For the other port modules, retain these build requirements when wiring the application:

- `desktop_os.rs` needs `base64 = "0.22"` and `image = { version = "=0.25.9", default-features = false, features = ["jpeg", "png", "webp"] }` in the desktop Tauri crate. Keep the exact image pin while the workspace uses Rust 1.85.
- `discovery.rs` needs `mdns-sd = { version = "0.21.2", default-features = false, features = ["async"] }` in `loomtv-core`, plus `pub mod discovery;` in the core library.

No new Tauri capability is required for the Foundation activity API.
