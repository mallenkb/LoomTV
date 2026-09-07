# macOS media controls

`apps/desktop-tauri/src-tauri/src/media_control.rs` owns LoomTV's process-wide macOS Now Playing session. It uses the public MediaPlayer framework through `objc2-media-player`.

The service implements `media-control:publish` and `media-control:release`. It normalizes the existing `MediaSessionSnapshot`, publishes title, series or episode context, duration, elapsed time, playback rate, queue position, and playback state, and enables only the commands listed in `supportedCommands`. Skip commands use the configured forward and back intervals.

MediaPlayer callbacks emit `loomtv:media-control:command` to the owning Tauri window with the existing `[command, handledInMain]` payload. `handledInMain` is currently `false`, so the renderer performs the action. The service does not restart playback, switch engines, or create a new playback session.

All MediaPlayer objects and callback targets live in thread-local state accessed only through Tauri's main-thread scheduler. The Runtime-facing `MediaControl` value contains only `Send` and `Sync` state. Release disables commands, removes every registered callback target, clears Now Playing metadata, and sets the playback state to stopped. The host must call `shutdown()` during application exit and `release_all()` when playback or profile ownership is torn down.

The controller keeps Electron's ownership and contention behavior. A stopped snapshot or explicit release gives up the system slot. A later paused snapshot cannot reclaim it; LoomTV reclaims the slot only after publishing a playing snapshot.

Artwork is omitted in this bounded implementation. The renderer supplies an `artworkUrl`, while MediaPlayer needs a local `NSImage`. The existing URLs may point at authenticated LoomTV protocol resources, so the host needs a bounded, authorized staging step before artwork can be added safely. No remote artwork download occurs here.

Add these macOS-only dependencies:

```toml
block2 = "0.6"
objc2-media-player = { version = "=0.3.2", default-features = false, features = ["std", "block2", "MPMediaItem", "MPNowPlayingInfoCenter", "MPRemoteCommand", "MPRemoteCommandCenter", "MPRemoteCommandEvent"] }
```

Add `mod media_control;`, construct `MediaControl::new(app.handle().clone())` in Runtime, and route both media-control channels to `MediaControl::handle`. Other operating systems report the `unsupported` adapter explicitly.

No native MediaPlayer call, application launch, artwork fetch, or runtime playback verification was performed.
