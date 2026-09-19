# Playback and memory check, 19 September 2026

## Result

Local macOS playback now tries the existing in-process libmpv engine first, with LibVLC retained as a startup fallback. The supplied 4K file uses VideoToolbox hardware decoding through libmpv. VLC 3.0.23 instead reports a VideoToolbox session error of -4 and falls back to software HEVC decoding with ten frame threads on this Mac.

The original video remains 3840 × 2160, HEVC Main 10, 30 fps, BT.709 SDR, with E-AC-3 5.1 audio. Playback does not transcode or reduce resolution. The 1440p and 1080p measurements use separate 45-second Main 10 samples derived from the supplied file. Those samples are test inputs only.

### Main-process memory

These are medians from Electron's macOS private-memory measurement, in MiB. They include native allocations and differ from RSS. Samples exclude paused playback and the final held frame. The updated windowed runs used the same copied library profile.

| Video | Previous LibVLC path | Updated libmpv path |
| --- | ---: | ---: |
| Supplied 4K file | 1,496 MiB | 737 MiB |
| Derived 2560 × 1440 sample | Not measured | 504 MiB |
| Derived 1920 × 1080 sample | Not measured | 483 MiB |

The measured 4K main-process reduction is about 51%. The new engine applies to all local video resolutions on macOS, but these results do not establish a before-and-after percentage for 1440p or 1080p.

A separate fullscreen 4K sample measured **1,182,046,928 bytes across all four processes**, about 1.10 GiB, with macOS `footprint`. Closing playback reduced that total to about 526 MiB. Fullscreen buffers cost more than the windowed case. The user's IINA screenshot totals about 781 MB in its displayed units. That is a useful comparison target, but it is not a controlled run with matching window size and playback state.

RSS is lower and varies with memory compression. For that reason, the headline comparison above uses private memory rather than treating RSS as Activity Monitor's memory value.

### Playback checks

- The supplied 4K file played through multiple short samples, including a 200-second measured run, fullscreen, pause, resume, seeking, and close. This was not a full 26-minute viewing or a long leak test.
- All three resolutions reported `hardwareDecoder: videotoolbox`, their original test-input dimensions, 30 fps, and zero decoder frame drops.
- One 4K run recorded two display drops around transitions. The final 4K control run reported zero at the sampled checkpoint. The 1440p and 1080p samples each recorded seven initial display drops, with no additional drops through steady playback. These checks do not justify claiming that no frame ever dropped.
- The 45-second samples reached their final frame. Inspection exposed missing handling for mpv's keep-open EOF event. That event and seeking out of the ended state now have regression coverage.
- Text subtitle placement was measured on the earlier native playback fixture. In an 800 px viewport, the saved bottom inset was 32 px; visible controls raised it to 148 px, leaving 32 px above the timeline. The final libmpv subtitle mapping and suppression of duplicate native text have automated coverage and static checks. Fullscreen computer-control limitations prevented completing the final visual subtitle recheck.

## Changes

- Prefer libmpv for local macOS video. Its existing VideoToolbox path avoids this VLC software-decoding fallback. Network/IPTV routing and other platforms retain their existing order.
- Correct mpv crop reset to use an empty geometry, which its API accepts. The previous `no` value stopped playback during initial settings application. The Rust command contract uses the same correction.
- Normalize native bridge flags so pause, mute, and selected tracks remain accurate. Preserve ffprobe stream indices separately from mpv track IDs. Honor disabled subtitles and avoid rendering native text underneath the app overlay.
- Handle mpv keep-open EOF and mark a seek as loading until the native restart acknowledgment arrives.
- Suppress identical native snapshots and repeated track arrays in Rust and the Electron adapter. Idle Rust workers block, and paused LibVLC polling slows to 250 ms. A paused 1080p comparison reduced repeated renderer state messages from about 59 per second to zero.
- Retain recently visited details within existing count and byte limits, with eviction based on recent access. Catalog changes and mutations still invalidate cached data.
- Move text subtitles above measured controls, then restore the saved position. ASS dialogue uses the app's text styling after extraction, so authored ASS positioning and effects are not preserved. Bitmap subtitles retain native rendering.
- Set About-panel and packaging copyright to `Copyright © 2026 LoomTV`.

Reducing VLC's software thread pool saved memory in preliminary tests, but the most aggressive configuration dropped frames. No thread cap, forced lower bit depth, or reduced playback resolution was shipped.

## Verification and delivery

The full desktop suite was run under Electron's embedded Node runtime with the Electron-compatible SQLite addon. The final run reported 606 passed, 3 skipped, and 1 TODO, with zero failures. Rust workspace tests passed with 40 passed and 2 ignored; scanner Rust tests previously passed. Production builds, type checking, changed-source ESLint, cache tests, subtitle-layout tests, native lifecycle tests, and the final focused regressions passed.

The ordinary Node 24 suite encountered a native SQLite cleanup-hook assertion. The complete suite passed under the actual Electron runtime. Its test executable was placed in a path without spaces so generated test-worker shebangs could execute. This does not repair the separate Node 24 test-environment failure.

The changes and production build are local. The installed release and the original library database were not replaced. Tests used a copy of the library. The staged libmpv library currently depends on local Homebrew libraries; portable release packaging still needs dependency bundling and verification before distribution.

[IINA also uses mpv](https://iina.io/). Closing the remaining memory gap needs further profiling of native rendering buffers and the desktop shell. The existing Rust/Tauri desktop path could reduce Chromium overhead, but that migration was not performed in this change.

Raw measurements, decoder logs, generated samples, and test logs are under `/tmp/loom-memory-20260919` and are not committed artifacts.

## Follow-up by process

The final macOS build no longer prewarms VLC at app startup, probes it after library startup, or probes it when the player module loads. VLC still initializes when selected for fallback or network playback and reuses that instance afterward. Windows retains its startup warmup. The final 4K test loaded libmpv and no libvlc dylib, confirmed with `lsof`; its IPC trace contained no VLC availability requests.

Two macOS `footprint` samples during windowed 4K playback measured the following. The window was 1280 × 800 logical pixels. Both builds used production assets, the copied library profile, and the supplied video. The samples cover different moments in the video, and the second final sample followed pause and resume with the controls visible.

| Process | Before this follow-up, MiB | Final build, MiB |
| --- | ---: | ---: |
| Main, including native playback | 754–797 | 705–773 |
| Chromium GPU helper | 51–58 | 56–71 |
| Interface renderer | 81–84 | 89–93 |
| Network service | 7.3 | 7.3–7.6 |
| All four, including shared accounting | 892–939 | 867–926 |

These short samples overlap. They do not establish a reliable additional percentage reduction, and they do not show a GPU or renderer improvement. Removing the unused VLC load avoids unnecessary work, but most remaining memory belongs to active native playback and the desktop shell. The network service already has a small footprint.

An experiment removed the covered library from layout during playback. It did not produce a consistent GPU or renderer saving, so it was reverted. Browsing state, artwork and detail caching, hardware acceleration, decode settings, and output resolution retain their existing behavior.

The final 4K sample used VideoToolbox at 3840 × 2160 and 30 fps. It reported zero decoder and display drops at the measured checkpoints. Pause, resume, close, and return to the cached title details worked. These are short checks, not a long playback or leak test.

The follow-up desktop suite passed with 607 passed, 3 skipped, and 1 TODO under Electron's Node runtime. Final native-memory regressions passed 10 of 10; type checking, changed-source ESLint, production builds, and `git diff --check` passed. Rust code was unchanged in this follow-up. The installed app and original database were not replaced.

The measurements are saved as `process-before-*`, `process-after-*` for the rejected layout experiment, and `process-final-*` under `/tmp/loom-memory-20260919`.
