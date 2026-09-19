# Cross-platform playback implementation

## Changes

- Local playback tries VLC hardware, mpv hardware, mpv software, VLC software, then the existing browser compatibility path. Software preference is a policy choice, not a claim that one engine wins on every machine.
- Each hardware attempt must report an active decoder and decoded video before acceptance. Failed candidates release their native resources. Switching preserves position, pause, volume, mute, speed and track preferences.
- Windows has a Rust libmpv bridge using HWND embedding and D3D11 output. VLC retains its Windows native host.
- Linux has a Rust libmpv bridge and a shared X11 video underlay behind the transparent Electron window. It handles input exclusion, window positioning, display scaling, visibility and cleanup. Wayland desktops require XWayland for this native path.
- A Rust VLC probe records decoder evidence without calling JavaScript from native decoder threads. It also guards the private X11 connection against window teardown errors.
- Packaging stages both engines and their bridges. mpv dependency staging handles macOS and Linux library dependencies. CI includes native bridge builds on macOS, Windows and Linux.
- The control panel is 28 CSS pixels shorter. Top padding is 40 px, bottom padding is 16 px, and the timeline gap is 8 px. Button hit targets are unchanged.

## Verification

- Full desktop suite: 622 tests, 618 passed, 3 skipped, 1 TODO, no failures.
- Rust core, playback and bridge tests: 38 passed, 2 ignored. The Tauri libmpv host also passed 6 focused tests.
- TypeScript checks, targeted ESLint, production builds, workflow policy and diff whitespace checks passed.
- The supplied original 4K HEVC file opened in isolated Electron checks using VLC VideoToolbox, VLC software, mpv VideoToolbox and mpv software. The checks preserved the paused position at 60 seconds.
- Startup verification took roughly 1.31 seconds for VLC hardware, 0.95 seconds for VLC software, 0.49 seconds for mpv hardware and 0.44 seconds for mpv software. These are isolated startup checks, not visible-frame latency or comparative playback benchmarks.
- A later repeat of the temporary Electron check stalled and was stopped. It did not produce a new decoder result.

## Limits

Windows and Linux GPU playback and visual composition have not been run on those operating systems. Their implementation and build checks do not establish identical scrubbing feel or driver compatibility. The compact controls received static checks, without a new visual check. The installed application and original library database were not replaced.

Decoder property semantics follow the [mpv manual](https://mpv.io/manual/stable/#hwdec-current). Explicit software mode enables mpv's software fallback setting; disabling that setting caused video startup to fail with the local runtime even when hardware decoding was disabled.
