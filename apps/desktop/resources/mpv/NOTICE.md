# MPV distribution notice

macOS arm64 builds of Loom bundle libmpv as the playback engine used after
LibVLC and before Chromium/HLS. The payload is the `libmpv-darwin-arm64.tar.gz`
archive in the [runtimes-2026-09 release](https://github.com/mallenkb/LoomTV/releases/tag/runtimes-2026-09).
`apps/desktop/native-runtimes.json` pins its SHA-256, and
`scripts/fetch-native-runtimes.cjs` checks it before extracting it to
`resources/mpv/lib/`.

## Source

`scripts/bundle-libmpv.cjs` builds the payload from Homebrew's mpv bottle on
an Apple silicon Mac. It copies libmpv and every non-system library it depends
on into one folder, rewrites each library's references to its neighbours, signs
the results ad hoc, and adds Loom's render bridge
(`native/libmpv/render-bridge`). `libmpv-inventory.json` inside the archive
lists each file with its Homebrew formula, version, and SHA-256.

Homebrew builds these libraries for the macOS version they are installed on, so
this payload requires macOS 26 or later. On older macOS versions libmpv does
not load, and Loom goes from LibVLC straight to Chromium/HLS.

| Homebrew formula | Version | Files |
| --- | --- | --- |
| dav1d | 1.5.3 | `libdav1d.7.dylib` |
| ffmpeg | 8.1.1 | `libavcodec.62.dylib`, `libavfilter.11.dylib`, `libavformat.62.dylib`, `libavutil.60.dylib`, `libswresample.6.dylib`, `libswscale.9.dylib`, `libavdevice.62.dylib` |
| fontconfig | 2.18.3 | `libfontconfig.1.dylib` |
| freetype | 2.14.3 | `libfreetype.6.dylib` |
| fribidi | 1.0.16 | `libfribidi.0.dylib` |
| gettext | 1.0 | `libintl.8.dylib` |
| glib | 2.88.3 | `libglib-2.0.0.dylib` |
| graphite2 | 1.3.15 | `libgraphite2.3.dylib` |
| harfbuzz | 14.2.1 | `libharfbuzz.0.dylib` |
| jpeg-turbo | 3.2.0 | `libjpeg.8.dylib` |
| lame | 3.100 | `libmp3lame.0.dylib` |
| libarchive | 3.8.7 | `libarchive.13.dylib` |
| libass | 0.17.4_1 | `libass.9.dylib` |
| libb2 | 0.98.1 | `libb2.1.dylib` |
| libbluray | 1.4.1 | `libbluray.3.dylib` |
| libplacebo | 7.360.1 | `libplacebo.360.dylib` |
| libpng | 1.6.58 | `libpng16.16.dylib` |
| libsamplerate | 0.2.2 | `libsamplerate.0.dylib` |
| libudfread | 1.2.0 | `libudfread.3.dylib` |
| libunibreak | 7.0 | `libunibreak.7.dylib` |
| libvmaf | 3.1.0 | `libvmaf.3.dylib` |
| libvpx | 1.16.0 | `libvpx.12.dylib` |
| little-cms2 | 2.19 | `liblcms2.2.dylib` |
| luajit | 2.1.1781602682 | `libluajit-5.1.2.dylib` |
| lz4 | 1.10.0 | `liblz4.1.dylib` |
| mpv | 0.41.0_6 | `libmpv.dylib` |
| mujs | 1.3.9 | `libmujs.dylib` |
| openssl@3 | 3.6.3 | `libssl.3.dylib`, `libcrypto.3.dylib` |
| opus | 1.6.1 | `libopus.0.dylib` |
| pcre2 | 10.47_1 | `libpcre2-8.0.dylib` |
| rubberband | 4.0.0 | `librubberband.3.dylib` |
| shaderc | 2026.2 | `libshaderc_shared.1.dylib` |
| svt-av1 | 4.1.0 | `libSvtAv1Enc.4.dylib` |
| uchardet | 0.0.8 | `libuchardet.0.dylib` |
| vulkan-loader | 1.4.350.1 | `libvulkan.1.dylib` |
| x264 | r3222 | `libx264.165.dylib` |
| x265 | 4.2 | `libx265.216.dylib` |
| xz | 5.8.3 | `liblzma.5.dylib` |
| zimg | 3.0.6 | `libzimg.2.dylib` |
| zstd | 1.5.7_1 | `libzstd.1.dylib` |

## Licenses

The bundle is GPL-covered. mpv is GPL-2.0-or-later in this configuration, and
Homebrew's FFmpeg links x264 and x265, which are GPL-2.0-or-later. The other
libraries use their own licenses (LGPL, MIT, BSD, zlib, Apache-2.0, and
others); each formula's license and source archive are listed at
`https://formulae.brew.sh/formula/<name>`.

Loom's own code remains MIT. Distributing this payload requires keeping these
notices with the release and providing the corresponding source, or a written
offer for it, for the GPL-covered libraries. The Homebrew formula pages link
the exact upstream source archives for the versions above.

## Behavior

Loom loads libmpv in the desktop process through its render bridge. It never
launches an mpv executable or opens a separate player window. Existing
profile/path validation, device and stream authorization, and server-side
direct-play/transcode decisions remain in force; libmpv cannot bypass them.
