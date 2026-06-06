# LoomTV Roadmap

This roadmap captures the current direction for LoomTV. It is intentionally practical: the project should remain a reliable local-first media library and player, not a streaming service or media source.

## Current Focus

### 1. Stabilize the Monorepo

Move the desktop app, mobile client, and backend functions into a clear workspace structure without breaking existing desktop releases.

Expected outcomes:

- Clear package boundaries under `apps/desktop`, `apps/mobile`, and `convex`
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

### 3. Improve Local Network Workflows

Support paired-device and LAN workflows without weakening the local-first privacy model.

Expected outcomes:

- Clear pairing and rate-limit behavior
- Safer local server defaults
- Better diagnostics for network availability
- Explicit user control over network sharing

### 4. Build the React Native Remote Client

Develop the Expo React Native app as a companion client for browsing and playing a paired desktop library from another device.

Current foundation:

- Mobile UI for Home, Movies, TV Shows, Anime, Settings, detail pages, episode lists, and continue watching.
- Pairing against the desktop app with a base URL and 6-digit code.
- Library loading from the paired desktop app.
- Mobile playback through `expo-video`.
- HLS/transcode startup for formats that need a mobile-compatible stream.
- Playback progress sync back to the desktop host.
- Convex schema and functions for hosts, paired devices, media sync, playback progress, and remote control commands.

Near-term outcomes:

- Document the supported setup clearly: same-LAN remote playback first.
- Make pairing, refresh, progress sync, and stream errors easier to recover from.
- Add mobile setup documentation and screenshots.
- Verify iOS and Android playback behavior against direct streams and HLS/transcode sessions.
- Decide whether Internet remote streaming belongs in scope, and if so define the security model before exposing anything outside the local network.

### 5. Make Maintenance Easier

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

## Not Planned

- Providing movies, TV shows, anime, subtitles, or copyrighted media.
- Building a hosted streaming catalog.
- Adding scraping or download features for copyrighted content.
- Sending local library contents to a hosted service by default.

## Success Criteria

LoomTV is moving in the right direction when:

- Users can install and update the desktop app reliably.
- Local libraries scan and remain stable across app restarts.
- Playback works for common formats with understandable fallbacks.
- Privacy and local network behavior are explicit.
- Contributors can understand the repository, run checks, and make small improvements without private context.
