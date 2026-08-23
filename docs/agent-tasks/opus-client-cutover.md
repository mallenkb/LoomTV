# Opus task: cut desktop and mobile over to the canonical server

Start only after the migration gate is accepted. Read
[the shared contract](./video-unification-shared.md),
[the remaining implementation contract](./opus-remaining-implementation.md),
[the Sol handoff](./sol-core-platform-handoff.md), and the current
[Opus ledger](./opus-handoff-ledger.md) completely. Read the instructions under
`apps/mobile` before changing mobile code.

## Outcome

Make desktop and mobile direct clients of the canonical `/api/v1` server, then
make desktop hosting start that same server after verified migration. Preserve
the current and prior client generation through bounded adapters only.

## Step 1: freeze the client map

Inventory every desktop and mobile request, renderer IPC dependency, stored
credential, onboarding state, playback action, LAN advertisement, protocol
handler, and legacy server lifecycle hook. Map each to an active canonical
route, a compatibility adapter with a removal condition, or a typed retirement.

Completion criterion: every `/api/v2` call and direct legacy-state dependency is
accounted for before dependent edits start.

## Step 2: move shared client journeys

Implement canonical discovery, certificate trust, pairing and sign-in, account
and invitation sessions, profile selection and PIN state, library and details,
progress, lists, playback plans and renewal, tracks, downloads, devices,
revocation, recovery, and sign-out in desktop and mobile. Onboarding must cover
local desktop hosting, standalone NAS or server setup, and connecting to an
existing server. Public client state cannot contain raw paths or server-only
records. Tokens stay in the existing secure native boundary, never renderer or
plain application storage.

Completion criterion: focused tests trace every core journey against desktop
hosted and standalone server configurations. Core client code has no unaccounted
legacy route or state dependency.

## Step 3: cut over desktop hosting

Wire `createCanonicalServerHost` into the desktop lifecycle after migration is
committed. Start one server and one store before creating the window. Adapt the
renderer, `plexserver://` handling, LAN advertisement, native playback, update
shutdown, transcode teardown, app quit, and partial-start cleanup to canonical
services. Remove the legacy server as a live authority. Fix restart-in-place or
make the lifecycle explicitly single-start with a typed result.

Completion criterion: no startup or failure path can run two authorities. A
failed migration or partial server start cannot open the renderer against
legacy state. Shutdown releases the listener and active media work.

## Step 4: prove the cutover

Add focused contract, security, lifecycle, and client-state tests. Run desktop
and mobile type checks, their focused tests, route scans, syntax checks, and
`git diff --check`. Preserve the user's `apps/mobile/app.json` delta and design
QA files.

Completion criterion: the ledger accounts for every changed path, route, state
record, compatibility adapter, and command result. End with
`CLIENT_CUTOVER_READY` only when no known implementation blocker remains.
