# Native mpv playback

LoomTV uses a local-desktop mpv backend without replacing the
LoomTV server, React player controls, or FFmpeg/HLS compatibility path.

## Runtime setup

1. Install mpv for the current platform, or set `LOOMTV_MPV_PATH` to an mpv
   executable.
2. Play a local library item. LoomTV automatically uses mpv when it is
   available.

LoomTV checks packaged-runtime locations, common system locations, then `PATH`.
Remote desktop items and missing/broken mpv installations automatically use the
existing Chromium/HLS player.

## What the integration covers

- Direct local-file playback without a LoomTV FFmpeg session.
- Main-process ownership of the mpv process and JSON IPC socket/named pipe.
- Typed, allowlisted renderer commands.
- Existing LoomTV controls for play/pause, seeking, volume, mute, speed,
  fullscreen, episode navigation, progress, skip prompts, and settings panels.
- Instant mpv audio, primary-subtitle, and secondary-subtitle selection.
- Live subtitle delay/style and audio delay.
- Embedded and authorized local subtitle files.
- Cleanup when playback closes, the renderer is destroyed, the app quits, or
  an update starts.

## Deliberate limits

- The current integration uses a user-installed mpv runtime. It does not copy the local
  Homebrew/system binary into release packages.
- Remote mpv direct play is not enabled yet. The current remote `/stream` route
  is browser-oriented and may remux or transcode away embedded tracks.
- The React window is created transparent so it can act as the control layer
  above mpv. Normal app screens remain opaque in CSS. A production version
  should move this to a dedicated transparent playback window after the
  macOS/Windows/Linux window-synchronization behavior is validated.
- Shipping mpv is blocked on a documented GPL-versus-LGPL distribution choice,
  pinned per-platform builds, checksums, notices, signing, and packaged-runtime
  verification.

## Suggested manual validation

Use a local MKV with multiple audio and subtitle tracks and verify:

- startup and resume position;
- pause, seek, volume, mute, and speed;
- audio switches without a reload;
- primary and secondary subtitles;
- ASS/SRT/PGS rendering and delay changes;
- fullscreen episode transitions;
- close, app quit, and missing-mpv fallback;
- moving/resizing between displays and macOS Spaces/Windows virtual desktops.
