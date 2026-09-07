# Embedded libmpv draft

Status: incomplete and not connected to either desktop backend. Do not merge
this as a completed MPV replacement. Both committed backends still use the
external MPV fallback. No native playback success is claimed by this draft.

## Included code

This draft leaves the pre-existing `../bridge.m` untouched.

`bridge.m` is a macOS render-API bridge with a C ABI intended for both Electron
and Tauri. It loads libmpv directly with `dlopen`; it contains no player-process
launch path. It uses the installed upstream `mpv/client.h` and `mpv/render_gl.h`
headers rather than a handwritten copy of their ABI.

Creation prepares an idle core without opening media or creating a window.
Attach creates an NSOpenGLView inside a host-owned native child view. Commands
use the asynchronous client API. Polling drains a bounded number of events and
returns allocated JSON. Shutdown frees the render context on AppKit's main
thread before destroying the core on the worker thread.

This is source code, not a verified native binary. OpenGL timing, fullscreen,
Retina scaling, hardware decoding and teardown still require native tests.
Windows and Linux render hosts are not implemented here.

## Build the experimental bridge

On a macOS development machine with upstream libmpv headers installed:

```sh
LIBMPV_INCLUDE_DIR=/absolute/path/to/include \
  node apps/desktop/native/libmpv/draft-render-bridge/build.mjs
```

The include directory must contain `mpv/client.h` and `mpv/render_gl.h`. The build
script compiles the bridge only. It neither installs libmpv nor enables a new
playback path. The output is ignored by Git. Runtime signing, dependency staging
and distribution have not been implemented for this draft.

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
once, and reports persistent cleanup failure. These renderer changes apply to
both Electron and Tauri because they share the same React source.

LibVLC still requires a composited host. A partial successful reply with the wrong
surface is stopped instead of leaked. Delayed seeks and metadata probes are
cancelled during disposal. The MPV adapter does not falsely report composition
when the host still returns an external window.

## Validation actually run

On Linux with Node 22.16.0 and the globally installed TypeScript compiler:

```sh
tsc -p tsconfig.json
NODE_PATH="$(npm root -g)" node --experimental-strip-types --test \
  apps/desktop/tests/nativeSessionLease.test.ts \
  apps/desktop/tests/nativePlaybackLifecycle.test.ts
```

The first command refers to the isolated validation workspace's tsconfig, not
the repository-wide desktop tsconfig. It strictly typechecked NativeSessionLease.
The second command ran 49 tests: 29 lease tests and 20 tests exercising the actual
renderer adapter classes against a mocked desktop transport. The suite includes
1,000 load/dispose iterations. All 49 passed. It does not test libmpv, LibVLC,
Electron, Tauri, an actual media file, audio output, GPU rendering or process RSS.

The repository test command discovers the two new `.test.ts` entrypoints. Their
case files use the existing TypeScript dependency to transpile the renderer
classes for isolated transport tests.

Not run: full desktop typechecking, full repository test suite, Electron build,
Rust checks, Tauri build, native bridge compilation, packaged-app execution or
manual playback. No performance or memory improvement is claimed.

## Work still required before enabling libmpv

1. Implement and connect the Electron worker adapter and Rust/Tauri adapter to
   this C ABI. Preserve source authorization, profile/remote scope checks and
   the high-level command allowlist. Delete the executable launch/socket path.
2. Reuse the existing LibVLC native child hosts and viewport/fullscreen updates.
   Match startup pre-warm scheduling and measure first-play and repeat-play time.
3. Replace executable discovery/settings with library discovery and migrate old
   preferences without interpreting an executable as a shared library.
4. Stage libmpv, the bridge, dependent libraries and licenses for both runtimes;
   verify architectures, signing and clean-machine packaged startup.
5. Force LibVLC failure, then libmpv failure, and verify the remaining browser/HLS
   path without changing network playback authority. Verify real frames, sound,
   pause, seek, subtitles, EOF/replay, rapid replacement, fullscreen and shutdown.
6. Add native integration/stress tests and review callback/core lifetime under
   sanitizers before declaring the migration ready.
