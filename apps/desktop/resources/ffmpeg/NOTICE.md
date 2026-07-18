# FFmpeg Notices

LoomTV bundles FFmpeg command line tools so users do not need to install FFmpeg separately.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project. LoomTV is not affiliated with the FFmpeg project.

## macOS bundle

- Tools: `ffmpeg`, `ffprobe`
- Platform: macOS Apple Silicon / arm64
- Build source: Martin Riedl's FFmpeg Build Server
- Build URL: https://ffmpeg.martin-riedl.de/
- Download URLs:
  - https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffmpeg.zip
  - https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffprobe.zip
- FFmpeg revision reported by the bundled tools: `N-124279-g0f6ba39122`
- Configure line reported by the bundled tools:

```text
--prefix=/Volumes/ffmpeg_arm64/out --pkg-config-flags=--static --extra-version='https://www.martin-riedl.de' --enable-gray --enable-libxml2 --enable-version3 --enable-gpl --enable-openssl --enable-libfreetype --enable-fontconfig --enable-libharfbuzz --enable-libsnappy --enable-libsrt --enable-libvmaf --enable-libass --enable-libklvanc --enable-libzimg --enable-libzvbi --enable-libaom --enable-libdav1d --enable-libopenh264 --enable-libopenjpeg --enable-librav1e --enable-libsvtav1 --enable-libvpx --enable-libvvenc --enable-libwebp --enable-libx264 --enable-libx265 --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libtheora
```

## Windows bundle

- Tools: `ffmpeg.exe`, `ffprobe.exe`
- Platform: Windows x86_64
- Build source: CODEX FFMPEG by Gyan Doshi
- Build URL: https://www.gyan.dev/ffmpeg/builds/
- Download URL: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
- Package version: `ffmpeg-8.1.1-essentials_build`
- Source reference listed by the build provider: https://github.com/FFmpeg/FFmpeg/commit/239f2c733d

## License

The bundled FFmpeg builds include GPL components, so the bundled FFmpeg tools are distributed under the GNU General Public License version 3 or later, as applicable to those builds and their included libraries.

LoomTV invokes FFmpeg as separate command line executables. The FFmpeg binaries remain third-party software owned by their respective copyright holders.

For FFmpeg source code, documentation, and legal details, see:

- https://ffmpeg.org/
- https://ffmpeg.org/legal.html
- https://git.ffmpeg.org/ffmpeg.git
