# LibVLC VideoToolbox initialization fix

## Cause and patch

VLC 3.0.23 starts a VideoToolbox HEVC session whenever the container supplies nonempty codec extra data. A valid 23-byte `hvcC` record can contain zero parameter-set arrays, with VPS, SPS, and PPS delivered in the video packets instead. The user's 3840 × 2160, 30 fps, Main 10 MKV has this layout. VideoToolbox rejects that incomplete configuration with status `-4`, and unmodified VLC falls back to software decoding.

The patch waits until the HEVC parser has VPS, SPS, and PPS, then builds the VideoToolbox configuration from those parsed sets. It preserves the original media, resolution, bit depth, and frame rate. No remux, transcode, thread limit, or libmpv substitution is involved.

The change is in VLC's existing Objective-C decoder. The verification program is Rust. Source and license remain those of the [official VLC 3.0.23 release](https://download.videolan.org/pub/videolan/vlc/3.0.23/).

## Reproduce

The build script accepts the official `vlc-3.0.23.tar.xz`, an existing VLC 3.0.23 Apple Silicon runtime, and a new output directory ending in `VLC.app`. It verifies the archive SHA-256, patches a temporary source copy, and builds only the VideoToolbox plugin. It does not download dependencies or change the input runtime.

```sh
bash apps/desktop/native/libvlc/build-videotoolbox-fix.sh \
  /absolute/vlc-3.0.23.tar.xz \
  /absolute/original/VLC.app \
  /absolute/patched/VLC.app

rustc --edition=2021 apps/desktop/native/libvlc/verify-videotoolbox.rs \
  -o /tmp/verify-videotoolbox
/tmp/verify-videotoolbox /absolute/patched/VLC.app /absolute/video.mkv 30
```

The probe requires hardware-only VideoToolbox and disables other decoders. It uses dummy video output and disables audio to isolate decoding. A pass requires pictures to reach the output. Inspect `lost` counters and the `vt cvpx chroma` log for frame loss and pixel format.

## Verification on 19 September 2026

The original GTA file has a 23-byte configuration record without parameter-set arrays. The patched decoder reads its in-band sets and produces `x420` 10-bit frames. The initial 30-second run delivered 895 pictures and reported zero lost pictures. The old plugin selected `avcodec`; the patched plugin selected `videotoolbox`.

Separate 15-second checks used the original 4K file and 45-second 1440p and 1080p HEVC Main 10 clips derived from it.

| Input | Decoder | Median decoder-process RSS | Lost pictures |
| --- | --- | ---: | ---: |
| Original 4K, unmodified plugin | Software | 1,107 MiB | 0 |
| Original 4K, patched plugin | VideoToolbox | 81 MiB | 0 |
| Derived 1440p, patched plugin | VideoToolbox | 77 MiB | 0 |
| Derived 1080p, patched plugin | VideoToolbox | 75 MiB | 0 |

These are isolated decoder-process measurements with dummy output. They exclude Electron, real display surfaces, audio, and allocations in macOS media services. They must not be presented as total LoomTV memory or compared directly with Activity Monitor totals. Full application rendering and the subsequent exit fix are recorded in [the full application test report](full-app-check-2026-09-19.md). Full-movie and 60 fps playback remain unverified.

## Integration boundary

The patched runtime is staged in `apps/desktop/resources/libvlc/darwin/arm64`. The staging script regenerates the flattened macOS package manifest when replacing a runtime. The engine order and normal library database remain unchanged. The rebuilt source payload is `/tmp/loom-vlc-vt-fix/verified-runtime/VLC.app`.

To reproduce staging, supply the patched runtime's parent directory through `LOOMTV_LIBVLC_SOURCE_DIR`. The final application packaging must sign the containing bundle after staging. The build script signs only the replacement library for local loading. An ad hoc signed Apple Silicon application passed the package runtime and signature checks, and loaded its bundled VideoToolbox decoder during 4K playback. This is local verification, not a notarized release.
