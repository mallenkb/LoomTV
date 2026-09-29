# Bundled libmpv runtime

Loom embeds libmpv as its in-window playback engine after LibVLC. It loads the
library into the desktop process through Loom's native render bridge; it never
launches an mpv executable or opens a separate player window.

`scripts/fetch-native-runtimes.cjs` downloads the pinned macOS arm64 payload
into `resources/mpv/lib/` during `desktop:start` and packaging. Packaged builds
copy that directory outside `app.asar` so the library and bridge can be loaded
at runtime.

To rebuild the payload after changing the render bridge or updating mpv, run
`corepack pnpm --filter loom-media-server-desktop libmpv:bundle` on an Apple
silicon Mac with Homebrew's mpv installed. Set
`LOOMTV_SKIP_NATIVE_RUNTIME_FETCH=1` while testing a local bundle so the next
start does not replace it. Publishing a new payload means uploading a new
archive to a runtimes release and updating `native-runtimes.json`.

The application never downloads or executes a native runtime at runtime.
