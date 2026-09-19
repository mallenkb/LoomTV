# Windows and Linux libmpv bridge

This Rust library implements the version 1 `loom_mpv_*` ABI used by
`src/main/libmpvPlayback.ts`. It loads a supplied libmpv library in the Electron
process. It never starts an mpv executable.

`loom_mpv_create` allocates a libmpv core. `loom_mpv_attach` receives the native
child window owned by Electron, sets mpv's `wid` option, initializes the core,
and subscribes to playback properties. On Windows, the parent is an HWND and
mpv uses its D3D11 GPU context. On Linux, the parent is an X11 window ID and
mpv uses an X11 EGL or GLX context. The Linux host checks `DISPLAY` and rejects
pure Wayland sessions because mpv's `wid` embedding expects an X11 window.

The host sends decoder policy through `set_property` before `loadfile`, then
checks `hwdec-current` before reporting hardware playback as ready. mpv's own
`wid` child stays within the native video host. Electron keeps the controls in
its existing renderer above that host.

`scripts/stage-libmpv.cjs` builds this crate on Windows and Linux and copies the
result next to a supplied libmpv runtime in `resources/mpv/lib`. Release staging
must use `--required`. On Windows the script also copies DLLs beside `mpv-2.dll`,
which may include codecs or GPU dependencies. A release owner must review the
exact binary set, licenses, and runtime dependencies before distribution.

For required macOS staging, the script copies every non-system dylib dependency,
rewrites install names to `@loader_path`, and signs the staged copies locally.
For required Linux staging, it copies the non-system ELF dependency closure and
sets each library's RPATH to `$ORIGIN`. Both paths fail if a media dependency
cannot be found. Linux still needs a compatible system C library, display
server, and graphics stack on the destination machine.
