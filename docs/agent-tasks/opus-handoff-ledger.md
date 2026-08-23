# Opus handoff ledger

Single completion record for the Opus side of the video program, under
[the shared program contract](./video-unification-shared.md) and
[the remaining-implementation contract](./opus-remaining-implementation.md).

Verification labels are the four required by the program contract: **Implemented**,
**Statically verified**, **Runtime verification required**, **Device or platform
verification required**.

This pass ran focused checks. Every command and its result is in section 9. Nothing
below is labelled runtime- or device-verified without a command in that section.

**The program is not implementation-complete.** Section 10 names what remains and why.

---

## 1. Corrections to the previous ledger

The previous ledger's blocker list was written against an earlier working tree. Re-read
against the current repository, several claims were already false and would have sent the
next reader down a wrong path.

| Previous claim | Current fact |
| --- | --- |
| `relativePath` ships to clients in `publicLibraryItem` | False. `apps/server/src/public-api.js` `publicLibraryItem` emits only `id`, `title`, `kind`, `seriesId`, numeric fields, `available`, `sourceIds`, `legacyIds`, `animeLikely`, `summary`, `genres`, `providerIds`. No locator field remains. |
| The browser viewer stores its bearer in `localStorage` | False. The shipped viewer held the bearer in a closure variable and already supported the same-origin cookie mode with a CSRF header. |
| The browser viewer's `play()` assumes `GET /api/v1/media/{id}` returns a `directUrl` | False. It already requested a playback plan. The route returns `directUrl: null` by design and the viewer used `playbackPlanUrl`. |
| Sol's `desktopState` carrier has no `mediaIdentityEvidence` key | False. `DesktopCanonicalProjection` carries `mediaIdentityAliases`, `mediaIdentityEvidence`, `profileCredentials`, `profileAssignments`, `profileRestrictions`, `profileListEntries`, `trackPreferences`, `devices`, and `deviceCredentials`. The bridge now uses all of them. |
| Cast, download, invitation, device, and list routes are `reserved` | Partly false. In the current `packages/video-contracts`, downloads, invitations, devices, pairing, profile lists, profile PIN, profile preferences, and track preferences are **active**. Only `media.download.read` and the three `cast.sessions.*` routes remain `reserved`. |
| Migration is "designed, not implemented" | Superseded. See section 3. |

Route-table facts as counted from the current `CANONICAL_ROUTES`: **76 canonical routes,
72 active, 4 reserved**, plus 24 legacy adapters and 18 legacy model destinations. The
four reserved routes are `media.download.read` and `cast.sessions.create/update/stop`.

---

## 2. Changed paths

| Path | Change | Label |
| --- | --- | --- |
| `packages/video-migration/src/migrationBridge.mjs` | One-projection import, single verified backup, restriction resolution, independent readback, staging removed | Statically verified + focused tests |
| `packages/video-migration/src/desktopProjection.mjs` | Unified `DesktopCanonicalProjection`; explicit assignments; identity evidence; season and episode metadata; list scope demoted to a warning | Statically verified + focused tests |
| `packages/video-migration/src/desktopInventory.mjs` | Strict JSON columns; `seasons`; selection-revision merge | Statically verified + focused tests |
| `packages/video-migration/src/identityResolver.mjs` | Captures the full evidence ladder for every present record | Statically verified + focused tests |
| `packages/video-migration/src/ownerCredential.mjs` | Deterministic per-installation salt so a rerun is idempotent | Statically verified + focused tests |
| `packages/video-migration/src/canonicalMarker.mjs` | `readbackCanonicalCounts` reopens the committed database independently | Statically verified + focused tests |
| `packages/video-migration/src/rollback.mjs` | Kind-based restore destinations; no legacy-fallback claim | Statically verified + focused tests |
| `packages/video-migration/src/redaction.mjs` | Forbidden-key rule is value-aware | Statically verified + focused tests |
| `packages/video-migration/src/sourceStaging.mjs` | Staging and second backup removed; bundle and digest helpers retained | Statically verified |
| `packages/video-migration/src/errors.mjs` | Adds `desktop_state_malformed`, `canonical_readback_mismatch` | Statically verified |
| `packages/video-migration/src/index.mjs`, `index.d.ts` | Narrowed public surface; declarations rewritten | Statically verified + focused test |
| `packages/video-migration/bin/loomtv-migrate.mjs` | Rollback accepts desktop destinations; reports restored artifacts by kind | Statically verified |
| `packages/video-migration/package.json` | Adds a `test` script | Statically verified |
| `packages/video-migration/tests/migrationBridge.test.mjs` | New. 10 end-to-end checks against Sol's real importer | Implemented, passing |
| `apps/server/src/web-app.html` | Rewritten as the canonical browser client | Statically verified; runtime verification required |
| `apps/server/src/public-api.js` | OpenAPI document now describes `/api/v1/openapi.json` | Statically verified |
| `packages/video-contracts/package.json` | Adds a `test` script | Statically verified |
| `packages/video-contracts/tests/routeTable.test.mjs` | New. Binds the route table to the published surface | Implemented, passing |
| `.github/workflows/mobile-release-gate.yml` | Three `@loomtv/mobile` filters corrected to `@loom-media-server/mobile` | Statically verified |
| `scripts/verify-workflow-policy.cjs` | Workspace-selector and repository-script resolution | Statically verified + focused tests |
| `scripts/verify-workflow-policy.test.cjs` | Eight new tests | Implemented, passing |
| `scripts/verify-test-workspaces.cjs` | Registers `packages/video-contracts` and `packages/video-migration` | Statically verified + passing |
| `docs/agent-tasks/opus-handoff-ledger.md` | This ledger | Implemented |

Not touched, by instruction: `apps/mobile/app.json`, `design-qa.md`,
`design-qa-mobile-phone.png`, `design-qa-mobile-tablet.png`.

---

## 3. Migration: what changed and why

The previous draft was rejected for eight reasons. Each is addressed below, and each
correction has a test in `packages/video-migration/tests/migrationBridge.test.mjs`.

### 3.1 One projection, not staged legacy files

The draft wrote `headless-admin.json` and `headless-client.json` into a staging directory,
pointed Sol's plan builder at that directory, **and** passed a partial `desktopState`.
Sol's `createLegacyCanonicalImportPlan` reads the directory and merges the carrier, so
every staged record was counted twice.

The bridge now builds one `DesktopCanonicalProjection` carrying `adminState`, `profiles`,
`profileAssignments`, `profileSelections`, `progress`, `history`, `profileCredentials`,
`profilePreferences`, `profileRestrictions`, `profileListEntries`, `trackPreferences`,
`mediaIdentityAliases`, `mediaIdentityEvidence`, `devices`, and `deviceCredentials`, and
plans against the real data directory. No intermediate file is written.

### 3.2 The backup binds the authoritative source

Sol's `createVerifiedLegacyBackup` accepts `additionalArtifacts` and already copies a
SQLite artifact together with its `-wal` and `-shm` sidecars, digest-verifying each. The
bridge now passes the desktop database through that parameter, so the desktop database,
its WAL, its SHM, and any settings file land in the **same** manifest that
`commitLegacyCanonicalImport` records in the canonical marker. The draft's separate
`createVerifiedSourceBackup` is deleted: a second manifest the marker did not reference
could not be checked at rollback time.

### 3.3 Restrictions resolve against the projected roots

Sol's carrier normalization maps `allowedFolders` using the roots it read from the data
directory. In projected mode that set is empty, because the roots arrive in the
projection, so every grant failed as unmatched. The bridge now calls Sol's
`mapLegacyAllowedFolders` itself, against the roots this migration projects, and writes
`allowedRootIds` into the carrier. The fail-closed rule is still Sol's single
implementation.

| Legacy shape | Canonical result | Rule |
| --- | --- | --- |
| `profile_library_access` empty for a profile | `allowedRootIds: null` | Desktop treats empty as "every folder". Copying `[]` would revoke the whole library. Recorded as decision `empty_library_grants_map_to_all_roots`. |
| Grant equals a root path | `allowedRootIds: [rootId]` | Exact match. |
| Grant is a subfolder of a root | **Migration stops** | `legacy_restriction_unrepresentable`. Widening to the root would give a restricted profile more access than it has today. |
| Grant matches no root | **Migration stops** | Same error, `legacy_folder_restriction_unmatched`. |

### 3.4 Assignments are stated, not inferred

`profileAssignments` was `[]` while each profile carried `ownerId`. Sol's normalizer
inferred a `manage` assignment per profile, so the imported count exceeded the source
count and `validateReconciliation` rejected the commit with
`migration_reconciliation_mismatch`. The projection now emits one explicit `manage`
assignment per profile.

### 3.5 Malformed input stops

`desktopInventory` parsed every JSON column with a silent fallback, so a corrupt
`preferences_json` became `{}` and a profile lost its preferences without a word. It now
throws `desktop_state_malformed` naming the table, the column, and an opaque row
reference. An absent or empty column is still a legitimately absent value.

### 3.6 Evidence is strong enough to repair a later move

The resolver recorded only `filesystem-id` for files that were present, so the next move
had nothing stronger than a device and inode pair, which does not survive a copy across
volumes. It now records the whole ladder — content-sha256, filesystem-id, quick-hash —
for every present record, subject to `allowContentHash`, `allowQuickHash`, and
`maxContentHashBytes`. Reconnection order is unchanged: content hash, then filesystem
identity, then quick hash. One evidence value matching more than one record, or more than
one candidate, reconnects nothing and is reported as `ambiguous_media_relink`.

### 3.7 The public surface carries no secrets

`prepareCanonicalMigration`, `readDesktopInventory`, `projectDesktopState`,
`resolveMediaIdentity`, `createOwnerAccount`, and `resolveWorkDirectories` all returned
objects holding password or PIN hashes, device secret digests, raw locators, or Sol's
`plan.state`. They are no longer exported. The public surface is
`planCanonicalMigration`, `runCanonicalMigration`, `inspectCanonicalMigration`,
`rollbackCanonicalMigration`, and redaction, error, evidence, and filename helpers. A
test serializes a real plan result and asserts the media root, the PIN hash, the PIN salt,
and the owner password are all absent.

### 3.8 Rollback restores to real destinations and starts no legacy server

The draft copied every backup artifact into the data directory under its backup filename,
which would drop a desktop database into the server data directory as
`desktop-source-1.sqlite`. Restore destinations are now resolved from the artifact
**kind**: legacy headless files go to the data directory, `desktop-sqlite*` goes back
beside the desktop app with its sidecars, `desktop-settings` goes to its own path. An
artifact whose destination the caller did not supply raises `rollback_evidence_missing`
rather than being guessed.

The rollback text no longer says the canonical store falls back to legacy files. It does
not: legacy JSON and SQLite are read-only migration inputs and are never a fallback store
after cutover. Rollback returns the installation to the previous product.

### 3.9 Idempotence

`createOwnerAccount` drew a random scrypt salt. The migration ID is a hash covering the
projected owner credential, so every attempt produced a different migration ID and no
rerun could be recognised. The salt is now derived from the owner account ID, which is
itself derived from this installation's profile identifiers, so it stays unique per
installation and stable across attempts. A completed rerun returns `recovered: true` and
writes nothing; the test asserts four canonical tables do not grow.

### 3.10 Independent readback

`readbackCanonicalCounts` reopens the committed database through a separate read-only
handle and compares 22 canonical tables against the plan's expected target counts,
raising `canonical_readback_mismatch` on any difference. Success is no longer reported on
the strength of the writer's own word.

---

## 4. Browser client

`apps/server/src/web-app.html` is rewritten as the canonical browser client.

Journeys: onboarding, sign-in, profile selection with PIN and lock state, Home with
continue-watching and recently-added, Movies, Series with seasons and episodes, details,
watchlist, search, direct or HLS playback, audio and subtitle selection, progress, mark
watched, invitation session with an explicit leave action, switch profile, and sign-out.

Security decisions:

- The bearer lives in one closure variable. There is no `localStorage`, `sessionStorage`,
  `IndexedDB`, cache, or URL write. Over HTTPS the client uses the same-origin cookie mode
  with the `X-Loom-CSRF` double-submit header and holds no bearer at all. Over cleartext it
  holds a bearer for the tab only and says so on the sign-in screen.
- Playback never assumes a direct URL. It requests `playbackPlanUrl`, uses the capability
  URLs the plan issues, renews them before expiry, and stops the session on close.
- A track change is applied by re-planning. The server owns the decision; the client
  never rewrites a capability URL.

Client capabilities are probed rather than asserted: `canPlayType` decides which video and
audio codecs are advertised, and HLS is advertised only when `Hls.isSupported()` or native
HLS is available.

States implemented: loading (with a live-region announcement), empty, permission denied,
unavailable source, incompatible client (an API-version mismatch is a terminal screen),
expired session, offline, revoked device, expired invitation, capacity exceeded, and a
scoped retry.

Accessibility implemented: skip link, one polite and one assertive live region, a visible
`:focus-visible` ring on every control, `aria-pressed` on tabs, seasons, and list toggles,
`aria-label` on every icon-only or repeated action, focus moved to a heading when a panel
opens and returned to the opening control when it closes, `Escape` closing the player and
detail panel, `k`/`j`/`l` and arrow-key playback control, rem-based sizing so browser text
scaling works, a `prefers-reduced-motion` block, and a `prefers-contrast: more` block.

**Runtime verification required** for all of it. Nothing here has been opened in a browser.

---

## 5. Release policy

`.github/workflows/mobile-release-gate.yml` filtered every mobile command with
`@loomtv/mobile`. `apps/mobile/package.json` declares `@loom-media-server/mobile`, so the
gate's tests, typecheck, and native prebuild selected no package. All three filters are
corrected.

`scripts/verify-workflow-policy.cjs` gains `workspacePackageIndex` and
`workspaceSelectorViolations`, wired into `findPolicyViolations` and
`verifyWorkflowDirectory`. For every workflow line:

- `--filter <selector>` must resolve to a package in the current manifests, indexed from
  `pnpm-workspace.yaml` rather than a hard-coded list. Quoted, `=`-joined, `...`, `^`, and
  `[since]` selector forms are handled; a path selector must contain a `package.json`; a
  selector computed at run time is rejected because it cannot be verified.
- The command after a filter must be a pnpm built-in or a script that package declares.
  This is what would have caught a `--filter X run verify:tv-release` against a package
  with no such script.
- `node <path>` in a workflow must point at a file that exists, which covers the
  release-note, version, evidence, and attestation scripts.

All six checked-in workflows pass. The eight new tests cover the exact
`@loomtv/mobile` bug, a valid selector, a missing script, built-ins and quoting, a
run-time selector, a missing repository script, the package index, and the live
directory.

`scripts/verify-test-workspaces.cjs` now covers nine workspaces, including the two new
packages.

---

## 6. Cross-boundary changes

The revised contract permits targeted server or contract changes. Two were made:

1. **`apps/server/src/public-api.js`** — the OpenAPI document did not list
   `/api/v1/openapi.json`, so the document did not describe itself. One path entry added.
   No behaviour change; the route was already handled.
2. **`packages/video-contracts/package.json`** — a `test` script, plus a new
   `tests/routeTable.test.mjs`. The test asserts every `active` route is published, no
   `reserved` route is published, every legacy adapter names a destination and a removal
   condition, and the account-role and profile-kind vocabularies are the canonical ones.
   This is the guard that stops route-state drift from silently breaking every client.

---

## 7. Security and data-loss risks still open

1. Backup and rollback artifacts contain credential digests and raw media locators at mode
   0600, unencrypted. Operators need protected storage. (Sol's risk, unchanged.)
2. Content hashing every media file during migration is a full read of the library. It is
   the default because it is the only evidence that survives a cross-volume move;
   `allowContentHash: false` and `maxContentHashBytes` exist for slow NAS mounts. The
   trade-off is a slow first migration, not a correctness risk.
3. The desktop legacy media server is still the live authority in `apps/desktop/src/main.ts`.
   Until the cutover in section 10.1 lands, a desktop installation runs the legacy store.
4. Casting routes remain `reserved` and no client implements them, so no casting path can
   bypass authentication today — because there is no casting path at all.
5. External subtitle sidecars are still unindexed. `discovery.capabilities.externalSidecarSubtitles`
   is `false` and `packages/media-core` reports `adapterGaps: ['external_sidecar_subtitles']`.
   The browser track picker labels an `external` track when the probe reports one, so the
   client is ready for the capability before the server provides it.
6. An unsigned release remains possible; the workflow falls back to an ad-hoc macOS
   signature and an unsigned Windows installer when the certificate secret is absent.

---

## 8. Verification still required

**Runtime verification required**

- Every migration path against a real desktop installation: dry run, backup integrity,
  reconnection correctness over a real move, idempotent rerun, and rollback. The focused
  tests use a synthetic database and real files; they do not exercise a real install.
- Every browser-client journey, in at least one Chromium, one Gecko, and one WebKit
  browser, over both HTTPS cookie mode and cleartext bearer mode.
- The corrected mobile release gate, end to end on a macOS runner.

**Device or platform verification required**

- Screen-reader behaviour of the browser client (VoiceOver, NVDA, Narrator).
- Keyboard-only operation of every browser-client journey.
- Signed and unsigned release branches, notarization, and attestation verification.
- Everything in section 10, which has no implementation to verify yet.

---

## 9. Commands run

| Command | Result |
| --- | --- |
| `node scripts/verify-workflow-policy.cjs` | Pass. "Workflow policy passed for 6 workflows." |
| `node --test scripts/verify-workflow-policy.test.cjs` | Pass. 30 tests, 0 fail. |
| `node scripts/verify-test-workspaces.cjs` | Pass. "Test-workspace policy covers 9 workspaces." |
| `node --test packages/video-migration/tests/migrationBridge.test.mjs` | Pass. 10 tests, 0 fail. |
| `node --test packages/video-contracts/tests/routeTable.test.mjs` | Pass. 5 tests, 0 fail. |
| `node --check` on all 13 `packages/video-migration/src/*.mjs` and the CLI | Pass. |
| `node --check apps/server/src/public-api.js` | Pass. |
| `import('./apps/server/src/public-api.js')` | Resolves. |
| `import('./packages/video-migration/src/index.mjs')` | Resolves; 20 public exports, none carrying plan state. |
| Browser-client static scan (script parses under `vm.Script`; no storage API outside comments; 55 element lookups resolve; 22 canonical routes; no `/api/v2`) | Pass. |

Three defects were found **by** these checks and fixed, not worked around:

1. The redaction guard rejected Sol's own `redactions: { credentials: true }` assertion
   flag. The rule is now value-aware rather than the guard being relaxed.
2. Library grants failed as unmatched in projected mode, because Sol's carrier
   normalization sees an empty root set. Fixed in the bridge (section 3.3).
3. `migration_reconciliation_mismatch` on `profileAssignments`, from inferred assignments.
   Fixed in the projection (section 3.4).

No check was deleted, skipped, or weakened to make a result green.

---

## 10. Not implemented

These items in the remaining-implementation contract have **no implementation** in this
pass. They are listed with the smallest concrete blocker for each.

### 10.1 Desktop canonical-host cutover (Step 2, second half)

`apps/desktop/src/main/canonicalServerHost.ts` exists and is dormant by construction.
`apps/desktop/src/main.ts` line 2081 still calls `startMediaServer(mediaServerDeps)`.

Blocker: `createCanonicalServerHost` requires a `compatibilityHandler` that serves the
desktop renderer's existing routes from canonical services. That handler does not exist,
and the desktop renderer, the `plexserver://` protocol handler, LAN advertisement, mpv
playback, and transcode teardown all bind to the legacy server's port and IPC surface.
Swapping the listener without that handler would leave the renderer with no working
library, so the cutover is inseparable from 10.2.

Recorded, unchanged, for whoever lands it: `stopPromise` in the host is never cleared, so
a `start()` after a `stop()` rejects with `server_draining` permanently. Correct for
app-quit, but it prevents restart-in-place after a host, port, or TLS change.

### 10.2 Desktop and mobile canonical API migration (Step 3)

Not started. Desktop and mobile source still reference the `/api/v2` shapes the previous
ledger enumerated.

Blocker: both are large existing applications whose renderer state, onboarding, and
playback controllers are built on the legacy contract. This is the largest remaining item
and needs its own tranche.

### 10.3 Android TV and Fire TV client (Step 5)

Not started. No `packages/television` or `apps/tv` exists.

Blocker: greenfield application. The workflow verifier is ready for it — a filter naming a
TV package that does not exist, or a TV script that is not declared, now fails
`verify:workflow-policy`.

### 10.4 Casting (Step 6, first half)

Not started. `cast.sessions.create/update/stop` remain `reserved` in
`packages/video-contracts`, no handler exists in `apps/server/src/public-api.js`, and the
route-table test asserts that reserved routes are not published, so the contract and the
server agree.

Blocker: activating the routes requires a server-side cast-session registry bound to
account or invitation, profile, device, source, file identity, permission, expiry, and
revocation, which does not exist.

### 10.5 External subtitle sidecars (Step 6, second half)

Not started. `packages/media-core` still reports `adapterGaps: ['external_sidecar_subtitles']`
and discovery advertises `externalSidecarSubtitles: false`, so the gap is declared rather
than hidden.

Blocker: sidecars must be indexed as authorized media-source records by the library
scanner before a playback plan can select one. That indexing does not exist in
`apps/server/src/library-scanner.js`.

### 10.6 Documentation rewrite (Step 7, second half)

The release-policy half of Step 7 is done (section 5). The documentation half is not:
`README.md`, `docs/future-work.md`, `docs/nas-support.md`,
`docs/loomtv-vs-jellyfin-feature-status.md`, and `docs/canonical-migration.md` still
carry the previous pass's superseded markers and describe a desktop-only relay topology.

`docs/canonical-migration.md` in particular is now **wrong**, not merely stale: it
documents the staging directory, the second desktop source backup, and the public
`prepareCanonicalMigration` entry point, all of which this pass removed. It must be
rewritten before an operator follows it.

---

## Program completion status

Of the five program-completion conditions:

1. Documentation and release rules without known contradictions — **not met**. Release
   rules are corrected and verified; documentation is not (10.6).
2. One server, API, persistence, account model, and playback planner across desktop-hosted
   and NAS-hosted — **not met** (10.1).
3. Existing installations migrate without loss, with dry-run and rollback — **met in
   implementation**, with focused-test evidence and runtime verification outstanding.
4. Desktop, browser, mobile, and television clients on the canonical API — **not met**.
   Browser is done; desktop, mobile, and television are not (10.2, 10.3).
5. Remote access, downloads, casting, invitations, and private sharing enforce the agreed
   rules — **not met**. Casting is absent (10.4).

Runtime-complete status remains closed.
