# MPV distribution notice

The staged macOS arm64 payload in this checkout is the official mpv 0.41.0
macOS 14 arm release. Any other binary, dynamic library, or support file placed
under this directory is a separately supplied third-party artifact and must be
accompanied by release-specific provenance. This notice does not grant
permission to redistribute an unreviewed build.

Upstream artifact:
`mpv-v0.41.0-macos-14-arm.zip`

Source: <https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-macos-14-arm.zip>

Archive SHA-256: `5c96f9b21355fc0a11d2e2161ad65f33031070e9fb3f6bd9865fb459b94587e6`

Before shipping a payload, the release process must identify the exact upstream
MPV version or commit, source/archive URL, target architecture, build options,
and SHA-256 values. Keep the upstream `COPYING`/license text and copyright
notices with the release, provide the corresponding source or the applicable
written offer for the distributed GPL-covered build, and preserve notices for
MPV's linked or bundled dependencies. The exact build must be reviewed because
MPV's license mode and linked FFmpeg/codec libraries can change the obligations;
stock MPV is ordinarily GPL-2.0-or-later, while a particular build must be
represented by its own upstream license inventory.

Do not describe a stock GPL MPV payload as MIT or LGPL merely because LoomTV
itself is MIT. If a separately built LGPL-compatible variant is selected, keep
the build configuration, source, notices, and relinking/source-offer materials
that establish that variant's terms.

The native executable is used as LoomTV's local desktop playback fallback
while the experimental LibVLC surface remains behind its composition gate. If
the staged or system MPV runtime is unavailable or fails, LoomTV falls back to
Chromium/HLS. Existing profile/path validation, device and stream
authorization, and server-side direct-play/transcode decisions remain in force;
MPV is not a sharing server and cannot bypass them.
