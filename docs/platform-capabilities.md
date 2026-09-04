# Platform capabilities and verification

This matrix describes the implementation, not device certification. Platform playback, accessibility and failure recovery still require execution on the supported devices.

| Capability | Desktop | Hosted web | Mobile | TV |
| --- | --- | --- | --- | --- |
| Catalog and profiles | Implemented | Implemented | Implemented | Implemented |
| Playback | Native engines with browser fallback | Browser and server playback plan | Native player and server playback plan | Native player and server playback plan |
| Conditional catalog refresh and title details | Existing desktop index | Existing web API use | Uses the canonical catalog endpoint; older servers use compatibility requests | Existing library and series requests |
| Poster editing through canonical API | No canonical mutation endpoint | No canonical mutation endpoint | Hidden because unsupported | No canonical mutation endpoint |
| Server administration | Embedded server and administration | Administration interface | Use server administration | Use server administration |

## Catalog contract

`GET /api/v1/library/catalog` returns profile-filtered items and a numeric content revision. `If-None-Match` supports 304 responses. Authorization and active-profile restrictions run before conditional responses. A content hash changes when titles disappear, even if the newest item's timestamp stays unchanged.

`GET /api/v1/library/catalog?mediaId=...` returns only the selected title and its episodes, with the catalog revision. The server still evaluates the visible catalog to calculate that revision. This reduces transfer and client parsing; it does not yet remove the server's full catalog traversal.

## Failure behavior

Setup folder details require library management permission. Regular viewer roots remain redacted. Setup completion stops waiting after 30 seconds and offers a scan-status/retry message. Disconnecting the client stops setup polling; the background scan continues.

Desktop folder mutations are serialized. They apply server changes before committing the local view, compensate completed server changes when a later step fails, and explicitly report unsuccessful rollback. Scan scheduling failure does not turn a committed root addition into a failed addition. These are compensating operations, not a transaction across processes. Process termination or an ambiguous network response still requires reconciliation against server administration.

## Runtime checks before release

These checks were not executed for this change. Run them on disposable libraries and backups when runtime testing is authorized.

- A viewer receives 403 from setup folder listing and no absolute paths from regular root listing.
- An unchanged catalog returns 304. Removing an older title changes the ETag. A profile switch or revoked device cannot reuse cached access to restricted titles.
- A series detail response contains the selected series and its episodes without unrelated titles.
- Stalled setup returns within the deadline. Disconnecting stops polling. Successful scans still complete setup normally.
- Force server rejection and local write failure during folder add, remove and replacement. Confirm rollback, retry behavior and preservation of unrelated folders. Check recovery after killing the process between stores.
- Interrupt a NAS mount and restart the server during direct and transcoded playback. Confirm useful errors and recovery without duplicate playback sessions.
- Switch profiles during pending progress writes; revoke a playing device; reconnect after offline use; change audio and subtitle tracks during playback.
- Restore a backup into a disposable data directory and verify users, roots, profiles and progress.
- Check keyboard and TV focus, screen-reader labels, text scaling, empty libraries and connection errors on actual clients.

Keep release screenshots and setup instructions aligned with these behaviors. Update this matrix when a client starts using a new capability.
