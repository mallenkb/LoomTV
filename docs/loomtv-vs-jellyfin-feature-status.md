# LoomTV video feature status

This document records the current video-only implementation. It avoids invented completion percentages. A feature is either implemented in source, verified automatically, awaiting runtime/device evidence, or still planned.

## Current architecture

LoomTV has one canonical server, `/api/v1` contract, SQLite state store, account system, and media authority. The same runtime operates independently on a NAS or inside the packaged desktop application. Desktop, hosted web, mobile, and Android TV/Fire TV clients consume that server instead of keeping separate authoritative libraries or watch state.

Legacy desktop and headless data can be projected into the canonical store through the verified migration package. The canonical server never silently falls back to a legacy database after cutover.

## Implemented and automatically verified

| Area | Current behavior |
| --- | --- |
| Canonical state | Accounts, multiple administrators, users, profiles, PINs, restrictions, roots, catalog items, sources, devices, credentials, lists, preferences, progress, sessions, invitations, downloads, and audits persist in one SQLite store. |
| Migration | Desktop-only, headless-only, and combined migrations create verified backups, bounded redacted reports, atomic commits, readback evidence, idempotent reruns, and rollback artifacts. |
| Desktop host | The packaged entry starts the canonical TLS server, performs one-time migration, advertises its pinned identity, opens the hosted client, retains tray behavior, and uses the existing signed-update flow. |
| Headless/NAS | The GUI-independent runtime, container/systemd deployment, mounted-root health, scan preservation on mount loss, direct delivery, HLS fallback, backup/restore, logs, and admin UI are implemented. |
| Hosted browser | Owner setup, account sign-in, profiles/PINs, movies, series/seasons/episodes, search, lists, progress, direct/HLS playback, audio/subtitle selection, external text subtitles, downloads, private invitations, and browser casting controls are implemented. |
| Mobile | Pinned discovery/pairing, profiles/PINs, canonical catalog and progress, lists, direct/HLS playback, track selection, saved outage catalog, capability-based downloads, local offline playback, and local download removal are implemented. |
| Android TV/Fire TV | D-pad focus/back behavior, mDNS/manual HTTPS setup, certificate confirmation and pinning, pairing, invitations, profiles/PINs, movies and series, progress, lists, direct/HLS playback, renewal, track selection, and sign-out revocation are implemented. |
| Security | TLS enforcement, exact certificate pins for native clients, trusted-proxy allowlists, topology-aware remote policy, rate limits, scoped permissions, revocable device/session capabilities, path containment, bounded logs, and secret/path redaction are implemented. |
| Subtitles | Embedded tracks and `.srt`, `.vtt`, `.ass`, and `.ssa` sidecars are discovered without exposing server paths. Text-capable clients receive bounded VTT capabilities; other clients use burn-in. |
| Sharing and downloads | Owners can create scoped, expiring private invitations. Download leases bind account/invitation, device, profile selection, root, source identity, quota, and expiry. |
| Casting | The server has authenticated cast-session create/update/renew/stop contracts. The hosted browser binds them to the Remote Playback or AirPlay picker when the browser exposes one. |
| Release gates | Desktop, server, mobile, TV, contract, migration, workflow-policy, and workspace checks are wired into repository scripts or CI workflows. |

## Runtime or platform evidence still required

These are validation gaps, not alternate server implementations:

- Install, migrate, update, and roll back an actual packaged desktop build on macOS, Windows, and Linux.
- Run the phone/tablet matrix on physical iOS and Android devices, including large and interrupted offline downloads.
- Run the TV checklist on Android TV and Fire TV hardware, including remote focus, decoder fallback, certificate change, and store packaging.
- Run Chrome Chromecast and Safari AirPlay receiver tests. Self-signed receiver compatibility must be proven with the deployment certificate model.
- Validate FFmpeg software fallback and Intel, NVIDIA, AMD, Apple Silicon, and relevant NAS hardware acceleration under concurrent load.
- Run Docker/systemd deployments on representative NAS systems with restart, read-only media, offline mount, backup restore, and permission-loss drills.
- Test remote HTTPS behind each documented reverse-proxy pattern. LoomTV does not provide a hosted relay, router automation, or public streaming service.

## Remaining product work

The following are not complete in the current video scope:

- Android Chromecast sender controls and DLNA discovery/control.
- Multiple saved-server switching in mobile and TV clients.
- A friendly certificate-authority lifecycle for remote browser and receiver access.
- Durable scan job scheduling, cancellation, bandwidth/concurrency controls, and resume across a server restart.
- Rich device/session history and termination controls in the hosted admin dashboard.
- Collections, playlists beyond profile lists, editions, alternate versions, extras, local NFO import/export, and trickplay thumbnails.
- Webhooks, notifications, synchronized watch rooms, live TV, and DVR.

Music, photos, books, and comics are intentionally outside the current video-only product scope.

## Evidence commands

From the workspace root:

```sh
pnpm typecheck
pnpm test
pnpm desktop:build
pnpm --filter @loom-media-server/tv verify:config
pnpm verify:workflow-policy
```

Passing source checks do not replace the device and deployment evidence listed above.
