# 4K HEVC VideoToolbox fix

The bundled VLC 3.0.23 decoder opens a VideoToolbox session from nonempty HEVC `hvcC` data. The supplied 3840 × 2160 Main 10 file has a 23-byte `hvcC` header with zero parameter-set arrays; its VPS, SPS, and PPS arrive in video packets. VideoToolbox rejects the incomplete header with status `-4`, and VLC falls back to software decoding.

The patch waits for those packet parameter sets and builds a complete `hvcC` record only when both conditions hold:

- The longer visible dimension is at least 3840 pixels and the shorter dimension exceeds 1440 pixels, regardless of orientation.
- The source `hvcC` header has zero parameter-set arrays.

For every other input, including 1080p and 2560 × 1440 video, the original VLC conditions remain intact. This changes neither the source file nor playback resolution, bit depth, frame rate, engine order, or idle initialization.

The change is confined to VLC's existing VideoToolbox plugin. Its source comes from the [official VLC 3.0.23 archive](https://download.videolan.org/pub/videolan/vlc/3.0.23/). The build script checks that archive's SHA-256, applies the patch to a temporary source tree, builds the plugin, and places it in a copy of the supplied Apple Silicon VLC runtime.

```sh
bash apps/desktop/native/libvlc/build-videotoolbox-fix.sh \
  /absolute/vlc-3.0.23.tar.xz \
  /absolute/original/VLC.app \
  /absolute/patched/VLC.app

rustc --edition=2021 apps/desktop/native/libvlc/verify-videotoolbox.rs \
  -o /tmp/verify-videotoolbox
/tmp/verify-videotoolbox /absolute/patched/VLC.app /absolute/4k-video.mkv 30

clang -std=c11 -Wall -Wextra -Werror \
  apps/desktop/native/libvlc/test-videotoolbox-4k-gate.c \
  -o /tmp/verify-videotoolbox-4k-gate
/tmp/verify-videotoolbox-4k-gate
```

The probe requires VideoToolbox and counts displayed and lost pictures with dummy video output. It does not measure the desktop application's total memory. Compare its output and decoder logs with the unmodified plugin, then check 1080p and 1440p fixtures to confirm their original decoder behavior. The containing application needs signing after the plugin is staged.
