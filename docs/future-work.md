# Video roadmap

LoomTV is staying video-only for the current roadmap. Music, photos, books, comics, live TV, and DVR do not block this work.

## Release and platform validation

- Run packaged desktop migration, update, rollback, and playback on macOS, Windows, and Linux.
- Complete the physical iOS/Android phone and tablet matrix, including large and interrupted offline downloads.
- Complete Android TV and Fire TV hardware/store checks.
- Validate Chromecast and AirPlay receivers from supported browsers and iOS.
- Validate Docker/systemd installs on representative NAS platforms, including offline mounts, restarts, backup restore, and read-only media.
- Validate hardware transcoding and HDR fallback on Intel, NVIDIA, AMD, Apple Silicon, and selected NAS accelerators.

## Near-term product work

- Add an Android Chromecast sender and DLNA discovery/control without bypassing canonical cast-session authorization.
- Add multiple saved-server switching to mobile and TV.
- Add hosted device/session approval, naming, history, termination, invitation, download, and remote-policy management views.
- Add clearer remote HTTPS certificate lifecycle and reverse-proxy readiness checks. LoomTV will remain private and self-hosted; no hosted relay or subscription is planned.
- Make scan jobs cancellable, throttled, scheduled, and resumable across process restarts for large NAS libraries.
- Improve user-facing distinctions among an offline NAS, a removed file, a revoked capability, a decoder failure, and exhausted transcode capacity.

## Library depth

- Collections and richer ordered playlists.
- Editions, alternate versions, extras, trailers, and grouped duplicates.
- Local NFO import/export.
- Scheduled trickplay thumbnail generation.
- Better metadata-provider and artwork repair in canonical clients.

## Later video features

- Watch-together rooms with server-authoritative clocks and permissions.
- Webhooks and operator notifications.
- Live TV, guide data, time shifting, and DVR only after the core playback and deployment matrix is proven.

The current implementation and remaining evidence are tracked in [loomtv-vs-jellyfin-feature-status.md](loomtv-vs-jellyfin-feature-status.md).
