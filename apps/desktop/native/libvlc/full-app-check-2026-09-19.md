# Patched LibVLC full application playback check

19 September 2026, Apple Silicon macOS. This test used an isolated LoomTV build and a copied library. It loaded the patched VLC 3.0.23 runtime through `LOOMTV_LIBVLC_PATH` and `LOOMTV_LIBVLC_PLUGIN_PATH`. The normal application and its database were not replaced.

## Result

The original 4K HEVC Main 10 file and the derived 1440p and 1080p clips rendered inside LoomTV with VideoToolbox. The log selected `videotoolbox` and reported `vt cvpx chroma: x420` for each decoder instance. The video output used `caopengllayer` with `glconv_cvpx`. The 4K audio output successfully opened through AUHAL after initial format negotiation.

All inputs are 30 fps and retain 10-bit output. The original 4K source was not transcoded. Lower-resolution clips are 45-second HEVC Main 10 derivatives of the same source.

## Memory

The table sums the Electron main, renderer, GPU and network utility processes. Values are MiB. Physical footprint comes from macOS `proc_pid_rusage`, flavor 2. RSS is listed separately for comparison with earlier tests. They are different accounting methods and must not be mixed. Allocations in unrelated system processes are not included.

Samples were taken every five seconds during active playback with displayed frames, excluding paused, ended and closed states. Ranges are sampled values, not continuous peaks. Tests ran sequentially in the same app, so retained caches and changing window state affect the results. These values are observations, not fixed budgets or an isolated comparison between resolutions.

| Input | Median total physical footprint | Sampled footprint range | Median total RSS | Lost frames reported |
| --- | ---: | ---: | ---: | ---: |
| 4K original, 3840 × 2160 | 711.9 | 463.3 to 935.2 | 608.3 | 1 |
| 1440p derived clip, 2560 × 1440 | 490.8 | 486.3 to 865.8 | 647.6 | 0 |
| 1080p derived clip, 1920 × 1080 | 554.9 | 511.7 to 843.4 | 463.7 | 0 |

The 4K run contained approximately one minute of active playback and a pause/resume. It recorded one lost frame at the first sample after resume. The 1440p clip ran to its 45-second end with zero lost frames. The 1080p run included a resumed segment followed by playback from the beginning to the end, with zero lost frames in the samples. These short runs do not establish long-movie stability or performance at 60 fps.

The earlier software-decoded 4K test reported 1,622.6 MiB median total RSS. This run reported 608.3 MiB, about 62.5% lower. That earlier run used a different application build and test sequence, so the percentage is a historical comparison, not a controlled A/B result attributable only to this patch.

## UI finding

Exiting the 4K player with Escape closed the native playback session and released its output, but left a white window with stale subtitle text. Reloading the isolated renderer restored the library. Closing the completed 1440p and 1080p clips with the Close player button returned to their detail pages. The Escape/exit path needs investigation before calling the integration ready for release. This test does not establish whether the decoder patch caused that UI issue.

## Follow-up integration verification

The player close handler now commits the library view synchronously before native playback teardown. Two Escape exits in the updated isolated app returned to the library without reloading the renderer. Two active 4K playback sessions covered approximately 125 and 140 seconds of sampled playback and reported 3,774 and 4,307 displayed frames respectively, with zero lost frames. These are separate sessions, not a continuous full-movie test.

The shared seek preview now keeps a rounded bordered thumbnail above a separate timestamp pill. All local playback engines use this component. The thumbnail frame remains present while an image loads, avoiding a layout jump. The final package includes this source, but its hover appearance was not visually confirmed because the UI automation target stopped accepting actions after native menu activation.

Verification passed for 31 focused lifecycle, session, platform and runtime-staging tests, both TypeScript configurations, the main/preload/renderer builds, the macOS package runtime check, and strict recursive signature verification. A copy of the final package launched with the isolated profile and MPV disabled. Its log selected the bundled LibVLC runtime, selected `videotoolbox`, and reported `vt cvpx chroma: x420` while displaying the original 4K file. No runtime override was required.

The final package is `/tmp/loom-vlc-finish/apps/desktop/out/builder/mac-arm64/LoomTV.app`. It uses ad hoc signing for local verification. Follow-up evidence is under `/tmp/loom-vlc-finish`, including `focused-tests.log`, `package-final.log`, `runtime-check-final.log`, `packaged-run.log`, and `apps/desktop/measurements.ndjson`. These follow-up checks do not replace the memory measurements above or establish full-movie and 60 fps stability.

## Initial measurement evidence

- Isolated app build, probe and measurement script: `/tmp/loom-vlc-full-app`
- Raw samples: `/tmp/loom-vlc-full-app/measurements.ndjson`
- Filtered results: `/tmp/loom-vlc-full-app/results.json`
- Native decoder and output log: `/tmp/loom-vlc-full-app/runtime-final.log`
- Patched runtime: `/tmp/loom-vlc-vt-fix/verified-runtime/VLC.app`
- Measured app PID: `68864`, renderer `68871`, GPU `68867`, network utility `68868`

The probe forced the test app's MPV availability check to return unavailable, then used the app's normal LibVLC playback path. It observed LibVLC statistics through FFI and sampled the app's own process list. It did not inject decoded frames or replace the display output. Test-only JavaScript instrumentation remained under `/tmp`; no production TypeScript or Rust files changed for this measurement.
