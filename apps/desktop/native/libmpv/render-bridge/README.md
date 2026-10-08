# libmpv render bridge

`bridge.m` is a macOS render-API bridge with a C ABI for Electron. It is the
second playback engine after LibVLC and before Chromium/HLS.
`scripts/bundle-libmpv.cjs` builds it together with a self-contained libmpv,
builds download that bundle (see `resources/mpv/README.md`), and
`src/main/libmpvPlayback.ts` loads it.

It loads libmpv directly with `dlopen` and has no player-process launch path.
It uses the installed upstream `mpv/client.h` and `mpv/render_gl.h` headers
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
changes, including the controls' position transition. Rebuild the bundled bridge
alongside the desktop code when updating this ABI.

`corepack pnpm --filter loom-media-server-desktop libmpv:bundle` builds the
bridge and the libmpv bundle together. To build only the bridge on macOS:

```sh
LIBMPV_INCLUDE_DIR=/absolute/path/to/include \
  node apps/desktop/native/libmpv/render-bridge/build.mjs
```

The include directory must contain `mpv/client.h` and `mpv/render_gl.h`. The
output is ignored by Git.

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
