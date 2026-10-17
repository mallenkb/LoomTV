# libmpv render bridge

`bridge.m` is a macOS render-API bridge with a C ABI for Electron. It is the
second playback engine after LibVLC and before Chromium/HLS.
`scripts/bundle-libmpv.cjs` builds a self-contained libmpv, builds download
that bundle (see `resources/mpv/README.md`), `scripts/fetch-native-runtimes.cjs`
compiles this bridge into it, and `src/main/libmpvPlayback.ts` loads it.

It loads libmpv directly with `dlopen` and has no player-process launch path.
`include/mpv/` holds unmodified copies of the upstream `client.h`, `render.h`
and `render_gl.h` (ISC licence) from mpv 0.41.0, the version in the bundle,
rather than a handwritten copy of their ABI.

Creation prepares an idle core without opening media or creating a window.
Attach creates an NSOpenGLView inside a host-owned native child view. Commands
use the asynchronous client API. Polling drains a bounded number of events and
returns allocated JSON. Shutdown frees the render context on AppKit's main
thread before destroying the core on the worker thread.

## Build

Bridge ABI 2 adds a viewport-local subtitle shape for native GPU blur. Soft box
copies only the surrounding video region into GPU textures, applies horizontal
and vertical Gaussian passes, and composites through the same rounded shape
used by the subtitle overlay. No video pixels cross IPC. Plain and Solid box
clear the blur region. The renderer reports geometry during subtitle and layout
changes, including the controls' position transition.

When changing the ABI, bump `LOOM_MPV_BRIDGE_VERSION` in `bridge.h` and
`LIBMPV_BRIDGE_VERSION` in `libmpvPlayback.ts` together;
`tests/libmpvBridgeVersion.test.ts` fails if they differ. The host refuses any
other version.

The libmpv runtime archive also contains a bridge, but only as new as the
archive. 2.0.19 shipped the archive's version 1 bridge after the host moved to
version 2, so packaged builds lost libmpv while dev builds, with a locally
rebuilt bridge, worked. `fetch-native-runtimes.cjs` now compiles the bridge
from this folder over the archived copy, pinned to the bundle's minimum macOS,
and rebuilds it whenever these sources change. `verify-packaged-runtime.cjs`
checks the packaged bridge's recorded version and its exports.

To build only the bridge on macOS:

```sh
node apps/desktop/native/libmpv/render-bridge/build.mjs
```

Set `LIBMPV_INCLUDE_DIR` to build against other mpv headers. The output is
ignored by Git.

## Release builds

Release builds on macOS arm64 include the bridge and a self-contained libmpv.
Homebrew builds its libraries for the running macOS version, so the bundle
requires macOS 26; `libmpvPlayback.ts` checks the version recorded in
`libmpv-inventory.json` and reports libmpv as unavailable on older systems,
which then use Chromium/HLS after LibVLC. Supporting older macOS needs libmpv
built from source with a lower deployment target. Windows and Linux render
hosts are not implemented.

## C ABI rules for both hosts

- Keep all control calls for an engine on one serialized worker. Never let the
  AppKit main thread wait synchronously for that worker during attach or destroy.
- Supply a trusted, retained NSView pointer from the existing native child host,
  below the renderer controls. Never accept pointers from renderer JavaScript.
- Attach before loadfile. Check every return code and acknowledge async commands
  using their request IDs. A successful loadfile acknowledgement is not proof
  that a decoded video frame was displayed.
- Pass only authorized media/subtitle paths and validated, typed playback
  commands. The C bridge is not an authorization boundary or renderer-facing API.
- Free each non-null poll result with loom_mpv_free, including parse failures.
  Destroy consumes the engine exactly once, including partially attached engines.
- Retain the bridge library while any engine, callback or returned allocation is
  alive. Do not unload it while an AppKit render callback can still execute.

## Completed renderer hardening

The shared LibVLC and MPV renderer adapters now use NativeSessionLease. This
serializes startup/replacement, filters state by session ID, bounds early state
storage, cancels superseded queued starts, and reclaims late start replies after
close. Disposal is idempotent, waits for outstanding calls, retries a failed stop
once, and reports persistent cleanup failure.

LibVLC still requires a composited host. A partial successful reply with the wrong
surface is stopped instead of leaked. Delayed seeks and metadata probes are
cancelled during disposal. The MPV adapter does not falsely report composition
when the host still returns an external window.
