# Platform capabilities and verification

This matrix describes the implementation, not device certification. Platform playback, accessibility and failure recovery still require execution on the supported devices.

| Capability | Desktop | Hosted web | Mobile | TV |
| --- | --- | --- | --- | --- |
| Catalog and profiles | Implemented | Implemented | Implemented | Implemented |
| Playback | Native engines with browser fallback | Browser and server playback plan | Native player and server playback plan | Native player and server playback plan |
| Conditional catalog refresh and title details | Existing desktop index | Existing web API use | Uses the canonical catalog endpoint; older servers use compatibility requests | Existing library and series requests |
| Poster editing through canonical API | No canonical mutation endpoint | No canonical mutation endpoint | Hidden because unsupported | No canonical mutation endpoint |
| Server administration | Embedded server and administration | Administration interface | Use server administration | Use server administration |

## Storage boundaries

Desktop and the embedded server share `loomtv-canonical.sqlite`. Native repositories read and write compatibility views over canonical roots, catalog items, sources, profiles, restrictions, progress, lists, and preferences. Native-only records, including encrypted settings, artwork caches, and scan state, stay in extension tables in the same file. There is no normal fallback to `library.json` or a second writable video database.

Desktop startup consolidates an older `loomtv.sqlite` and, when needed, `library.json` into the canonical store. It keeps verified backups, records a migration ledger and redacted report, preserves established media IDs, and stops on unresolved identity or profile conflicts. Existing root and subfolder grants remain bounded during a combined import. See [migration and rollback](canonical-migration.md).

The native UI, IPC, playback engines, and LAN transport remain. The embedded canonical administration host binds to loopback by default. Explicit `LOOMTV_UNIFIED_DESKTOP=1` retains the hosted-client mode and LAN binding. A migrated desktop-only owner sets an account password through the existing owner setup screen; an existing server owner keeps its credential.

Migration, rollback, and canonical repository integration tests passed against disposable databases on 2026-10-24. The headless desktop suite also passed, including a real FFmpeg/ffprobe scan fixture. Bundled LibVLC 3.0.23 decoded a generated H.264/AAC clip resolved through the canonical native-library facade to end-of-file with dummy outputs. Hardware-only H.264 and HEVC probes selected VideoToolbox. Four additional 4K HEVC Main10 probes covered automatic selection and hardware-only decoding, each with normal and empty-array hvcC headers. All reached end-of-file with no corrupt packets or lost pictures.

Bundled libmpv passed software and VideoToolbox-copy decoding, pause, seek, resume, and end-of-file checks. Its production render bridge also presented VideoToolbox-decoded H.264 and HEVC frames in a background window on the built-in display, then released its AppKit and OpenGL owners. These checks ran on Apple silicon with macOS 27.2 using disposable clips. They do not establish HDR color accuracy, sustained 4K rendering performance, Intel/Windows/Linux behavior, or packaged installer/update behavior. Work is limited to local/NAS video; other media work and client feature expansion are paused.

## Catalog contract

`GET /api/v1/library/catalog` returns profile-filtered items and a numeric content revision. `If-None-Match` supports 304 responses. Authorization and active-profile restrictions run before conditional responses. A content hash changes when titles disappear, even if the newest item's timestamp stays unchanged.

`GET /api/v1/library/catalog?mediaId=...` returns only the selected title and its episodes, with the catalog revision. The server still evaluates the visible catalog to calculate that revision. This reduces transfer and client parsing; it does not yet remove the server's full catalog traversal.

## Failure behavior

Setup folder details require library management permission. Regular viewer roots remain redacted. Setup completion stops waiting after 30 seconds and offers a scan-status/retry message. Disconnecting the client stops setup polling; the background scan continues.

Desktop folder mutations are serialized and commit once in the shared SQLite store. The former cross-store folder journal and network compensation are no longer used. Catalog revisions invalidate native caches and cancel stale scan checkpoints after another connection changes the library. Server administration rejects stale snapshots instead of overwriting newer desktop changes.

Profile filtering uses canonical root grants and native subfolder grants together. Catalog requests reuse one access snapshot. Playback and downloads check the resolved file, so an allowed episode cannot authorize a denied sibling. Reset shuts down active playback and the embedded host before clearing video state and revoking credentials, then restarts the host against the reset store.

## Runtime checks before release

Automated headless suites cover parts of these flows. The following release checklist still requires packaged-app and device execution on disposable libraries and backups, especially interruption and playback recovery.

- A viewer receives 403 from setup folder listing and no absolute paths from regular root listing.
- An unchanged catalog returns 304. Removing an older title changes the ETag. A profile switch or revoked device cannot reuse cached access to restricted titles.
- A series detail response contains the selected series and its episodes without unrelated titles.
- Stalled setup returns within the deadline. Disconnecting stops polling. Successful scans still complete setup normally.
- Force a storage failure during folder add, remove, and replacement. Confirm the transaction preserves unrelated folders. Interrupt consolidation before and after publication, then verify recovery from the recorded backups.
- Change the library from desktop and server connections during a scan. Confirm stale writes are rejected and IDs, progress, lists, and offline source metadata survive.
- Import overlapping roots and profiles. Confirm neither accounts nor profiles gain access to previously denied folders, including alternate episode sources.
- Interrupt a NAS mount and restart the server during direct and transcoded playback. Confirm useful errors and recovery without duplicate playback sessions.
- Switch profiles during pending progress writes; revoke a playing device; reconnect after offline use; change audio and subtitle tracks during playback.
- Restore a backup into a disposable data directory and verify users, roots, profiles and progress.
- Check keyboard and TV focus, screen-reader labels, text scaling, empty libraries and connection errors on actual clients.

Keep release screenshots and setup instructions aligned with these behaviors. Update this matrix when a client starts using a new capability.
