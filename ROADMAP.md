# Loom Media Server Roadmap

This roadmap captures the current direction for Loom Media Server. It is intentionally practical: the project should remain a reliable local-first media library and player, not a streaming service or media source.

## Current Focus

The current implementation sequence is deliberately dependency-first: establish an independent server, make mounted storage safe, package it as an appliance, and only then expand client reach.

### 1. Establish the Headless Runtime Boundary

Run LoomTV as a real server without an Electron window, tray, dock, or graphical login session while preserving the existing desktop-host experience.

Implementation milestones:

- Centralize runtime paths for application data, cache, configuration, and bundled media tools.
- Move the HTTP server lifecycle behind a GUI-independent entry point.
- Add a `loomtv-server` CLI with explicit host, port, data, cache, and web-root configuration.
- Support graceful `SIGINT`/`SIGTERM` shutdown and machine-readable health output.
- Keep the desktop app as a client that can optionally start the same server runtime.

Current first slice:

- `apps/server` provides a GUI-independent health service and CLI.
- `packages/runtime-paths` resolves data, cache, and media roots consistently across platforms and containers.
- Docker, Compose, and systemd examples run the health service without Electron.
- `/admin/` provides owner onboarding, root health, catalog scans, operational status, and headless-state backup.

Acceptance criteria:

- The server starts from a shell on Linux with no display server.
- A second device can open the hosted web surface and reach authenticated library endpoints.
- Existing desktop hosting and local playback behavior remain unchanged.
- Database migrations and shutdown leave the server restartable without manual repair.

### 2. Stabilize the Monorepo

Keep the desktop app and mobile client in a clear workspace structure without breaking existing desktop releases.

Expected outcomes:

- Clear package boundaries under `apps/desktop` and `apps/mobile`
- Consistent pnpm workspace scripts
- CI that runs linting, typechecking, tests, and installer builds from the workspace root
- README and contributor docs that match the repository layout

### 3. Keep Desktop Playback Reliable

Preserve local playback quality while improving direct stream, HLS, and transcode fallback decisions.

Expected outcomes:

- Better format and codec handling across macOS, Windows, and Linux
- Safer transcode planning
- Continued support for saved progress, subtitles, next-episode prompts, and custom controls
- Focused tests for playback helpers and transcode decisions

### 4. Add Full NAS Library Support

Make network-attached storage a first-class Loom Media Server library source, not just a manually mounted folder that happens to scan.

Current foundation:

- Library folders are stored as filesystem paths and grouped by Movies, TV Shows, Anime, and Others.
- Mounted NAS shares can be added when the operating system exposes them through a normal folder path.
- Playback, probing, thumbnails, metadata matching, and progress already operate on stored file paths.
- Library Settings reports whether mounted folders are available.
- A scan preserves cached library items and scan-cache entries when a configured root is unavailable at scan start.
- Progressive scan snapshots retain completed folders during the current process.
- The headless server persists a JSON catalog, checkpoints background scans, and
  keeps existing records marked unavailable when a NAS root disconnects.
- The headless admin API can list catalog items and resolve only paths that
  remain inside their configured root.

Remaining outcomes:

- Add a dedicated NAS setup flow for mounted SMB/NFS shares in the desktop UI.
- Distinguish unavailable-at-start, disconnected-during-scan, unreadable, and degraded roots in Library Settings.
- Preserve existing library data when a NAS share disconnects during traversal, not only before scanning starts (the headless scanner now does this; desktop parity remains).
- Add NAS-aware scan throttling or resumable scanning for large network libraries.
- Clarify whether Windows UNC paths are supported directly or require mapped drives.
- Improve playback and scan errors so users can distinguish NAS offline, file missing, and transcode failure states.
- Document supported NAS setups for macOS, Windows, and Linux, including SMB/NFS shares mounted by the OS.
- Detect unavailable network paths before scan/playback and show a recoverable status instead of failing silently.
- Add clear desktop UI states for disconnected, reconnecting, scanning, and unavailable NAS folders.
- Avoid destructive scan behavior when a NAS mount is temporarily offline.
- Improve scan performance for large network libraries with incremental scanning, cache validation, and resumable progress.
- Keep playback and HLS/transcode behavior stable when reading from slower or higher-latency network storage.
- Add tests around offline shares, missing folders, path normalization, and scan-cache preservation.

Longer-term decisions:

- Decide whether Loom Media Server should manage SMB/NFS credentials directly or rely on OS-mounted shares only.
- Decide how to represent the same NAS library across desktop and mobile clients without exposing credentials to mobile devices.
- Define privacy and security rules for NAS paths, credentials, LAN streaming, and logs.

### 5. Package LoomTV as a NAS Appliance

Ship a supported container and service configuration after the independent server entry point exists.

Implemented milestones:

- Publish Linux `amd64` and `arm64` container targets that run as a non-root UID/GID.
- Define separate `/config`, `/cache`, and `/media` mounts, including read-only media support.
- Add Docker Compose and systemd examples, health checks, structured logs, and graceful shutdown.
- Document Intel, AMD, and NVIDIA device passthrough without enabling hardware access by default.
- Document backup, restore, upgrades, rollbacks, and host-mounted SMB/NFS expectations.

Acceptance criteria:

- A clean Compose deployment reaches healthy state without a desktop session.
- Restarting or upgrading the container preserves configuration, library state, and progress.
- Temporarily unmounting `/media` does not delete catalog entries.

### 6. Add Headless Web Administration

Use the hosted renderer as the control plane for onboarding, library management, playback, and operations.

Implementation milestones:

- Add first-run owner setup and local-network server onboarding.
- Expose library roots, folder health, scan controls, sessions, transcodes, logs, and backup from the browser. The headless server now exposes all of these except viewer/profile session identity, which remains a future client integration.
- Keep host filesystem paths and owner-only operations out of normal viewer responses.
- Move desktop-only renderer calls behind the same versioned HTTP contract used by web and remote clients.

Acceptance criteria:

- A new server can be configured and maintained entirely from another browser on the LAN.
- Owner operations require explicit authenticated authorization.
- Viewer sessions cannot access host paths, credentials, or administrative routes.

### 7. Improve Local Network Workflows

Support paired-device and LAN workflows without weakening the local-first privacy model.

Expected outcomes:

- Clear pairing and rate-limit behavior
- Safer local server defaults
- Better diagnostics for network availability
- Explicit user control over network sharing

### 8. Build the React Native Remote Client

Develop the Expo React Native app, currently in progress, as a companion client for browsing and playing a paired desktop library from another device.

Current in-progress foundation:

- Mobile UI work for Home, Movies, TV Shows, Anime, Settings, detail pages, episode lists, and continue watching.
- Pairing work against the desktop app with a base URL and 6-digit code.
- Library loading work from the paired desktop app.
- Mobile playback work through `expo-video`.
- HLS/transcode startup work for formats that need a mobile-compatible stream.
- Playback progress sync work back to the desktop host.
- Direct, authenticated desktop-to-mobile LAN sync for library and playback state.

Near-term outcomes:

- Document the supported setup clearly: same-LAN remote playback first.
- Make pairing, refresh, progress sync, and stream errors easier to recover from.
- Add mobile setup documentation and screenshots.
- Verify iOS and Android playback behavior against direct streams and HLS/transcode sessions.
- Support mobile playback from desktop-hosted NAS libraries without requiring the mobile device to mount the NAS directly.
- Decide whether Internet remote streaming belongs in scope, and if so define the security model before exposing anything outside the local network.

### 9. Make Maintenance Easier

Reduce release and review load so the project can keep shipping small, safe updates.

Expected outcomes:

- Better issue templates
- More focused tests around high-risk areas
- Clearer release notes
- Documented security and contribution processes
- Smaller follow-up tasks that contributors can pick up

## Near-Term Work

- Finish and publish the workspace README updates.
- Add issue templates for bugs, features, and good first issues.
- Add a NAS support guide covering mounted SMB/NFS shares, reconnect behavior, scan safety, and known limits.
- Add focused documentation for LAN sharing and security expectations.
- Add a mobile client README covering pairing, same-LAN streaming, supported platforms, and known limits.
- Keep release assets current for macOS, Windows, and Linux.
- Improve renderer bundle splitting without changing playback behavior. See `docs/future-work.md`.

## Good First Issues

These are suitable starter areas once filed as GitHub issues:

- Improve metadata setup documentation for TMDB, OMDb, TVmaze, and Jikan.
- Add troubleshooting notes for platform-specific installer warnings.
- Expand tests for library filters and search behavior.
- Improve empty-state copy for first-run library setup.
- Add screenshots for the mobile pairing flow once it is ready.
- Document mobile same-LAN playback requirements and common connection failures.
- Document how to add a mounted NAS share as a Movies, TV Shows, Anime, or Others folder.
- Add scan safeguards for temporarily offline NAS folders.

## Not Planned

- Providing movies, TV shows, anime, subtitles, or copyrighted media.
- Building a hosted streaming catalog.
- Adding scraping or download features for copyrighted content.
- Sending local library contents to a hosted service by default.

## Success Criteria

Loom Media Server is moving in the right direction when:

- Users can install and update the desktop app reliably.
- Local and NAS-backed libraries scan and remain stable across app restarts.
- Playback works for common formats with understandable fallbacks.
- Privacy and local network behavior are explicit.
- Contributors can understand the repository, run checks, and make small improvements without private context.
