# Chromaprint / fpcalc distribution notice

LoomTV packages the unmodified `fpcalc` 1.6.0 release binary from the
[Chromaprint project](https://github.com/acoustid/chromaprint/releases/tag/v1.6.0).
The archive is pinned and SHA-256 verified by `scripts/fetch-fpcalc.cjs`.

Chromaprint's own code is MIT licensed. The official `fpcalc` release also
contains and links third-party components; distribution must follow the
upstream [license inventory](https://github.com/acoustid/chromaprint/blob/v1.6.0/LICENSE.md).
The LoomTV detector does not use FFTW and does not copy Jellyfin Intro Skipper
code. Keep this notice and the upstream license inventory with distributed
builds, and repeat the dependency/license review when the pinned version is
changed.
