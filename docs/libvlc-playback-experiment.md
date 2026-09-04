# LibVLC desktop playback experiment

LoomTV includes a LibVLC bridge for **local desktop files only**. It does not
replace the LoomTV media server, direct-play/transcode decisions, or LAN,
remote, and mobile playback.

A raw BrowserWindow native drawable is not composited with WebContents, so the
surface was originally held behind an unconditional gate. That gate's
precondition is now met: `createMacOsNativeViewHost` inserts a real AppKit
child NSView at the bottom of Electron's content view, so LibVLC draws beneath
the renderer while controls, subtitles, panels, and fullscreen UI stay above
it, and no second OS-visible window is created.

## Gate and fallback behavior

On macOS and Windows the surface is enabled by default. macOS uses an NSView
child host; Windows uses a child HWND with the Direct3D11 vout. Linux remains
fallback-only and returns unavailable before Koffi or a native library is
loaded, so local playback there keeps the fallback order: MPV, then
Chromium/HLS.

`LOOMTV_LIBVLC_COMPOSITED_SURFACE=0` forces the old fallback-only behavior for
a launch; `=1` forces the surface on. The emergency kill switch is
`LOOMTV_DISABLE_EXPERIMENTAL_LIBVLC=1`; `LOOMTV_DISABLE_LIBVLC=1` remains a
legacy alias. `LOOMTV_EXPERIMENTAL_LIBVLC=0` and
`LOOMTV_ENABLE_LIBVLC=0` still opt out for a single launch. A specific library
and plugin directory can be supplied with `LOOMTV_LIBVLC_PATH` and
`LOOMTV_LIBVLC_PLUGIN_PATH` for a diagnostic or replacement runtime.

Native VLC console messages are disabled by default. Set
`LOOMTV_DEBUG_LIBVLC=1` before launching LoomTV to enable verbose VLC logs
and native surface diagnostics. Restart the app after changing this value,
since the warmed VLC instance lasts for the process lifetime. This only
controls logging; playback error states still reach LoomTV's player UI.

Packaged macOS arm64 releases stage the LibVLC payload under
`resources/libvlc/darwin/arm64`, and Windows x64 releases stage it under
`resources/libvlc/win32/x64`; both include the library, VLC plugin modules, and
plugin index outside `app.asar`. Development launches can still discover a
user/system-installed macOS `libvlc.dylib` (for example, from VLC.app or
Homebrew) or Windows `libvlc.dll` from standard VideoLAN installation
locations. LoomTV does not download native runtimes at application runtime. MPV is tried for
local playback before Chromium/HLS; network, LAN, and remote playback remain
on their existing browser/HLS paths.

## Security and scope

Only the trusted Electron main process opens the native player. Profile path,
local-path, and subtitle-to-media authorization checks run before LibVLC sees a
source. The renderer can send only the existing allow-listed playback
commands. Remote, LAN-shared, and mobile media continue using their existing
authenticated browser/HLS paths.

Linux falls back without attempting a LibVLC surface. Advanced LibVLC subtitle styling,
secondary subtitles, and video aspect/crop/rotation commands are not yet
implemented by the bridge and safely no-op or fall back.
