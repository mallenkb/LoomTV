# Bundled libmpv runtime

LoomTV embeds libmpv as its in-window native fallback after LibVLC. It loads
the library into the desktop process through LoomTV's native render bridge;
it never launches an mpv executable or opens a separate player window.

`scripts/stage-libmpv.cjs` prepares the local macOS development runtime under
`resources/mpv/lib/`. Packaged desktop builds copy that directory outside
`app.asar` so the native library and bridge can be loaded at runtime.

No native runtime is downloaded or executed by the application at runtime.
