# Video roadmap

Current development is limited to local and OS-mounted NAS video: movies, TV shows, anime, and other videos. Work on photos, music, audiobooks, books, and comics is paused. Existing clients and media code stay in place.

## Current cleanup

- Keep the Stremio client and validation in `packages/stremio-adapter`. Remove the unused native marketplace and executable-plugin contracts. Installed add-ons retain their existing state.
- Prefer tsrs for workspace compilation, with Microsoft TypeScript 7.1 beta and 7.0.2 as platform/startup fallbacks. Preserve the JavaScript compiler API used by existing tools.
- Share OMDb/MDBList ratings fallback between local video and add-on details. Reuse successful lookups, respect quota cooldowns, and require matching IMDb identity before combining scores.
- Use one canonical video database for native desktop and server operations. Preserve native UI/playback through compatibility views, verified migration backups, and rollback tooling.
- Keep the platform and performance documentation aligned with the code. Source implementation and device verification are separate claims.

## Next local-video work

Prioritize correctness with real libraries before new features. The checks below require separate test authorization.

1. Exercise folder recovery, offline mounts, interrupted scans, missing files, profile changes, and saved watch progress on disposable data.
2. Verify the implemented canonical desktop adapter, packaged backup, migration, update, and rollback on macOS, Windows, and Linux. Check identity, progress, folder grants, concurrent writers, and interrupted publication before release. Keep the legacy import schema and recovery tools while older installations need them.
3. Measure startup, scan throughput, memory, and playback using fixed video fixtures and the existing timing/budget tools. Compare engines with the same files and window state before changing their priority.
4. Improve resumable scan jobs and clear recovery messages where the preceding checks expose failures.

## Kept for the current product

Keep local scanning, metadata repair, profiles, watch progress, subtitles, downloads, backup/migration, and the existing LibVLC/mpv/browser playback paths. Keep Stremio integration as the supported add-on protocol. The Rust compiler change does not replace any playback engine or imply playback performance gains.

## Deferred

New media formats, a separate Loom-native plugin system, mobile/TV feature expansion, watch rooms, DVR, and additional casting integrations are outside this pass. Existing mobile, TV, and hosted-web functionality remains supported; platform validation is still needed before release.

[Platform capabilities and verification](platform-capabilities.md) records the current storage boundary and outstanding device checks. [Performance status](performance-and-memory-issues.md) separates implemented optimizations from measurements still needed.
