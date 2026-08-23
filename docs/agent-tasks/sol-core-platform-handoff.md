# Sol core-platform handoff ledger

Status: Steps 1 through 6 are implemented for static review. Runtime, migration, media, browser, packaged-desktop, and device verification remain required. Casting is still reserved.

## Canonical decisions

- `@loom-media-server/video-contracts` is the public contract authority. Password and PIN hashes are available only through its server-only export.
- The headless server package is the package-safe runtime and migration boundary used by standalone and desktop-hosted deployments.
- `loomtv-canonical.sqlite` is the sole live persistence authority. Legacy JSON and SQLite files are read-only migration inputs and are never fallback stores after cutover.
- A catalog item may retain multiple sources and identity aliases/evidence. Offline, unreadable, and missing sources remain catalog records.
- Playback planning, probing, direct play, remux/transcode selection, HLS, track selection, leases, and renewals use the canonical media path. Playback capabilities bind account or invitation session, profile, device, selection revision, media, source, and file identity.
- Remote access is disabled by default. Disabling it is reversible and gates remote traffic without deleting invitation or LAN download state. Explicit revocation remains separate.
- Canonical offline downloads use only persistent `LoomDownload` leases with transactional quota reservation. The old media download endpoints are retired.
- Canonical browser authentication supports an opt-in same-origin `HttpOnly; Secure; SameSite=Strict` session cookie with an Origin check and double-submit CSRF proof. Native bearer clients are unchanged. Cleartext browser use is memory-only for the current tab.

## Full backup and restore contract

Envelope `loomtv-canonical-backup` version 2 contains snapshot `loomtv-canonical-state-v1` version 1.

Durable state:

- accounts, owner singleton, and account credential hashes
- library roots, catalog items, media sources, aliases, and evidence
- profiles, PIN credential hashes, assignments, selections, progress, history, preferences, restrictions, lists, and track preferences
- devices, device credential hashes, and revocation state
- scan state, backup state, bounded operational logs, and migration markers
- remote policy, invitation records, and bounded redacted audit history

Excluded transient state:

- account sessions and login-attempt buckets
- pairing requests and unclaimed credential ciphertext
- invitation sessions
- active offline-download leases
- in-memory playback sessions and profile unlocks

Restore is owner-only and requires the authenticated principal ID, current owner ID, and snapshot owner ID to match. It validates the envelope checksum, exact schema/table/column inventory, required JSON syntax and canonical shapes, foreign keys, owner/profile invariants, canonical admin/client projections, SQLite integrity, and migration marker before commit. Replacement is one `BEGIN IMMEDIATE` transaction. Pending or accepted durable invitations are restored revoked. A pre-restore rollback artifact uses the same full snapshot contract; post-commit adapter failure attempts one atomic rollback and surfaces rollback failure rather than hiding it.

Backup artifacts are written through an exclusive mode-0600 temporary file, file sync, atomic rename, and directory sync. They remain sensitive because they contain credential digests and server-only media locators. The current format is integrity-checked but not encrypted.

## Changed Sol-owned paths

Contracts and shared media logic:

- `packages/video-contracts/package.json`
- `packages/video-contracts/src/index.mjs`
- `packages/video-contracts/src/index.d.ts`
- `packages/video-contracts/src/server.mjs`
- `packages/video-contracts/src/server.d.ts`
- `packages/media-core/src/index.mjs`
- `packages/media-core/src/index.d.ts`

Canonical server, persistence, security, compatibility, and browser surface:

- `apps/server/package.json`
- `apps/server/src/admin-service.js`
- `apps/server/src/auth-policy.js`
- `apps/server/src/canonical-persistence.js`
- `apps/server/src/canonical-state-store.js`
- `apps/server/src/cli.js`
- `apps/server/src/client-state.js`
- `apps/server/src/legacy-state-import.js`
- `apps/server/src/legacy-state-import.d.ts`
- `apps/server/src/legacy-v2-adapter.js`
- `apps/server/src/media-service.js`
- `apps/server/src/pairing-service.js`
- `apps/server/src/playback-session-registry.js`
- `apps/server/src/public-api.js`
- `apps/server/src/public-error.js`
- `apps/server/src/remote-policy.js`
- `apps/server/src/server.js`
- `apps/server/src/server.d.ts`
- `apps/server/src/transcoder.js`
- `apps/server/src/trusted-proxy.js`
- `apps/server/src/web-app.html`

Desktop packaging boundary:

- `apps/desktop/package.json`
- `apps/desktop/src/main/canonicalServerHost.ts`

Shared dependency metadata:

- `pnpm-lock.yaml` contains dependencies from both Sol and the migration/client workstream. Treat ownership of individual lockfile hunks as mixed.

This ledger is `docs/agent-tasks/sol-core-platform-handoff.md`. Sol did not modify mobile configuration, design QA assets, or `packages/video-migration`.

## Active canonical routes added in Step 6

- profile remove and PIN set/remove
- profile preference read/update
- profile list read/add/remove
- track-preference read/update
- active profile selection read, clear/lock, and automatic-sign-in update
- profile-scoped library list, series, and item detail
- owner-only full canonical restore

Library metadata now requires an active unlocked profile for account and device sessions. Child country rating, age, unrated, and allowed-root restrictions are applied per item. Invitation sessions use their live issuer, root, media, and profile scope.

## Retained compatibility and removal conditions

- `/api/v2` library, profiles, progress, preferences, lists, track preferences, playback plan, start-HLS, pairing, auth refresh, and unpair remain adapters to canonical services until the current and prior client generations stop calling them.
- `/api/v2/client-config`, active profile, lock, and automatic-sign-in remain adapters until profile API v1 clients leave the compatibility window.
- Provider artwork mutation and legacy playback-segment metadata return typed retirement responses until canonical contracts exist.
- `/stream` and legacy HLS URLs remain bounded capability adapters until every prior client uses canonical direct and HLS URLs and all issued capabilities expire.
- `/api/admin` and `/api/media` remain service adapters only. They must hold no independent catalog, profile, token, or download state.
- Legacy manual PIN pairing remains only where the desktop compatibility host supplies an explicit authorizer. Otherwise it returns a typed retirement before creating a pairing request.
- Legacy partial backups cannot replace a canonical store. They remain migration inputs only.
- The old `/api/v1/media/{mediaId}/download` and `/api/media/items/{id}/download` paths are retired. Only `/api/v1/downloads` lease creation/list/revoke/content is authoritative.
- Casting routes remain reserved for a separate tranche.

## Security and product risks

- Backup and rollback files contain credential hashes, device credential digests, invitation digests, and raw media locators. Mode 0600 limits local access, but operators need protected storage and transport. The SHA-256 checksum detects content changes but is unkeyed and does not authenticate provenance; owner-only restore is the authorization boundary. At-rest encryption is not part of this tranche.
- Cookie sessions require same-origin HTTPS or a trusted secure proxy. Cleartext browser sessions deliberately disappear on reload because their bearer remains in memory only.
- Trusted proxy configuration is security-critical. Untrusted or malformed forwarding is classified remote and fails closed, but deployment-specific proxy chains still need verification.
- External subtitle sidecar selection is not implemented. Embedded subtitle selection is canonical; sidecars remain a recorded adapter gap.
- TLS startup and certificate-fingerprint publication are implemented, but certificate rotation and proxy deployment behavior have not been exercised.

## Required verification

No tests or runtime commands were run during this workstream. Before release, verify:

1. Fresh install, legacy import, every staging/rename crash boundary, source reconciliation, and no fallback after cutover.
2. Full backup, owner mismatch, malformed JSON, corrupt checksum, restore, post-restore failure, and atomic rollback. Confirm all excluded sessions, pairing capabilities, invitation sessions, downloads, playback sessions, and PIN unlocks are unusable afterward.
3. Profile remove/PIN/preferences/lists/tracks/selection flows, including last-manager, last-profile, child, guest, PIN backoff, and selection-revision cases.
4. Library browsing under adult, child, locked, unrated, root-limited, disabled-account, revoked-device, and scoped-invitation contexts.
5. Same-origin HTTPS cookies and CSRF rejection in supported browsers and trusted-proxy deployments. Confirm no bearer reaches browser storage, logs, URLs, or response bodies in cookie mode.
6. Local and WAN remote-policy classification, rate limits, audit bounds/redaction, pairing approval/claim/revocation, invitation expiry/revocation, and download quota/range behavior.
7. Direct, remux, transcode, HDR/tone-map, HLS, track selection, multi-source selection, offline-source records, renewals, and immediate revocation with real FFmpeg/FFprobe inputs.
8. Packaged desktop startup and shutdown through the package export, with one listener and one store, partial-start cleanup, and no source-relative imports.
9. Current and prior desktop/mobile compatibility against every retained v2 route, then the Opus client cutover to the active v1 routes.
