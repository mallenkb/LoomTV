# Loom Media Server Roadmap

This roadmap captures the current direction for Loom Media Server. It is intentionally practical: the project should remain a reliable local-first media library and player, not a streaming service or media source.

## Current Focus

### 1. Stabilize the Monorepo

Keep the desktop app and mobile client in a clear workspace structure without breaking existing desktop releases.

Expected outcomes:

- Clear package boundaries under `apps/desktop` and `apps/mobile`
- Consistent pnpm workspace scripts
- CI that runs linting, typechecking, tests, and installer builds from the workspace root
- README and contributor docs that match the repository layout

### 2. Keep Desktop Playback Reliable

Preserve local playback quality while improving direct stream, HLS, and transcode fallback decisions.

Expected outcomes:

- Better format and codec handling across macOS, Windows, and Linux
- Safer transcode planning
- Continued support for saved progress, subtitles, next-episode prompts, and custom controls
- Focused tests for playback helpers and transcode decisions

### 3. Add Full NAS Library Support

Make network-attached storage a first-class Loom Media Server library source, not just a manually mounted folder that happens to scan.

Current foundation:

- Library folders are stored as filesystem paths and grouped by Movies, TV Shows, Anime, and Others.
- Mounted NAS shares can be added when the operating system exposes them through a normal folder path.
- Playback, probing, thumbnails, metadata matching, and progress already operate on stored file paths.

Near-term outcomes:

- Add a dedicated NAS setup flow for mounted SMB/NFS shares.
- Show NAS reconnect and offline status in Library Settings.
- Protect existing library data when a NAS share is temporarily disconnected.
- Add NAS-aware scan throttling or resumable scanning for large network libraries.
- Clarify whether Windows UNC paths are supported directly or require mapped drives.
- Improve playback and scan errors so users can distinguish NAS offline, file missing, and transcode failure states.
- Document supported NAS setups for macOS, Windows, and Linux, including SMB/NFS shares mounted by the OS.
- Detect unavailable network paths before scan/playback and show a recoverable status instead of failing silently.
- Add clear UI states for disconnected, reconnecting, scanning, and unavailable NAS folders.
- Avoid destructive scan behavior when a NAS mount is temporarily offline.
- Improve scan performance for large network libraries with incremental scanning, cache validation, and resumable progress.
- Keep playback and HLS/transcode behavior stable when reading from slower or higher-latency network storage.
- Add tests around offline shares, missing folders, path normalization, and scan-cache preservation.

Longer-term decisions:

- Decide whether Loom Media Server should manage SMB/NFS credentials directly or rely on OS-mounted shares only.
- Decide how to represent the same NAS library across desktop and mobile clients without exposing credentials to mobile devices.
- Define privacy and security rules for NAS paths, credentials, LAN streaming, and logs.

### 4. Improve Local Network Workflows

Support paired-device and LAN workflows without weakening the local-first privacy model.

Expected outcomes:

- Clear pairing and rate-limit behavior
- Safer local server defaults
- Better diagnostics for network availability
- Explicit user control over network sharing

### 5. Build the React Native Remote Client

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

### 6. Make Maintenance Easier

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
