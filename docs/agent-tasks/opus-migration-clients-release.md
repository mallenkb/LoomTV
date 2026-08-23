# Opus task: migration, clients, and release truth

Read [the shared program contract](./video-unification-shared.md) before starting
this task. This brief owns the bridge from existing installations and clients to
Sol's canonical server contracts.

## Owned paths

- `apps/desktop/src/**`, except `apps/desktop/src/main/**`
- `apps/mobile/**`, while preserving the existing user change in `app.json`
- Browser viewer HTML, styles, scripts, and client assets
- New Android TV and Fire TV client files
- New migration packages and migration command files
- `.github/workflows/**`
- Release and policy scripts
- Product, deployment, release, and status documentation

Treat server route implementations, shared server models, persistence, playback,
and remote-policy packages as Sol-owned.

## Step 1: Establish release truth

Correct stale product descriptions, package filters, signing behavior, component
version policy, deployment examples, project-tree documentation, and status
claims. Mark superseded plans and point them at the current authority document.

Completion criterion: every documented command, package name, version rule,
signing rule, deployment topology, supported capability, and incomplete feature
matches the repository state or carries a clear planned label.

## Step 2: Build the migration bridge

Consume Sol's canonical schemas. Inventory every desktop library, folder, media
record, metadata override, artwork reference, account-like profile, PIN, progress
record, history entry, list, and preference. Implement dry-run planning, verified
backup, transformation, import, report, and rollback. Preserve the original state
until the canonical server confirms the imported state is readable.

Completion criterion: every existing state record has a deterministic mapping,
retention decision, or reported incompatibility. Re-running a successful import
does not duplicate data. Failure restores the pre-migration state.

## Step 3: Move existing clients to `/api/v1`

Replace desktop renderer and mobile calls to legacy desktop routes with the
canonical discovery, authentication, profile, library, progress, playback,
device, and download contracts. Update onboarding to offer local hosting, NAS or
server setup, and connection to an existing LoomTV server.

Completion criterion: desktop and mobile can target either desktop-hosted or
standalone LoomTV without a desktop relay. Core journeys contain no direct call
to legacy state or route implementations.

## Step 4: Complete the browser viewer

Add the required video journey: onboarding, sign-in, profile selection, Home,
search, movie and series details, episode browsing, lists, direct or planned
playback, progress, offline and server-loss recovery, and accessibility behavior.

Completion criterion: each required journey has a complete success, empty,
loading, permission, unavailable-source, incompatible-client, and retry state.
Keyboard and screen-reader behavior is present in the implementation and listed
for later runtime verification.

## Step 5: Add television and client-side media features

Build the Android TV and Fire TV client on the canonical API. Implement remote
navigation, profiles, Home, search, details, playback, tracks, subtitles, and
recovery. Add mobile and desktop offline-download management, AirPlay,
Chromecast, and administrator-enabled DLNA. Add invitation, device, session, and
shared-library management.

Completion criterion: every client feature enforces account, profile, library,
device, and child restrictions returned by the server. Casting and downloads do
not create an unauthenticated path to media.

## Step 6: Align client recovery and accessibility

Use one recovery hierarchy across clients: inline repair, scoped retry, offline
mode, diagnostics, and administrator action. Implement reduced motion, focus
handling, scalable text, screen-reader semantics, keyboard input, and television
remote input for every core journey.

Completion criterion: every user-visible failure maps to a recovery action or a
clear terminal explanation. Every accessibility requirement has an implemented
path and an explicit runtime or device verification row.

## Step 7: Static completion review

Trace migration, onboarding, sign-in, profile selection, browsing, playback,
downloads, casting, invitations, revocation, server loss, updates, and rollback.
Inspect each changed workflow and documentation claim against the exact package,
path, command, and policy it describes.

Completion criterion: every owned-file change appears in a handoff ledger with
its contract impact and verification status. No stale percentage or unsupported
completion claim remains.

## Handoff format

Report:

1. Changed paths
2. Migration mappings and rollback behavior
3. Client contracts consumed from Sol
4. Server changes requested from Sol
5. Release and documentation corrections
6. Accessibility and recovery coverage
7. Security and data-loss risks still open
8. Runtime and device verification still required
