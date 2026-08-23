# Sol task: canonical video platform

Read [the shared program contract](./video-unification-shared.md) before starting
this task. This brief owns the server spine. Client behavior depends on the
contracts produced here.

## Owned paths

- `apps/server/src/**`, except browser HTML and client assets
- `apps/desktop/src/main/**`
- `packages/media-core/**`
- `packages/runtime-paths/**`
- `packages/transcode-capabilities/**`
- New shared server, persistence, authentication, playback, and remote-policy
  packages

Treat documentation, workflows, renderer files, mobile files, browser assets,
television clients, and migration packages as Opus-owned.

## Step 1: Freeze the canonical contracts

Define the canonical media identity, catalog records, accounts, roles, profiles,
sessions, client capabilities, playback plans, errors, and versioned routes.
Compare each definition with desktop and headless behavior before choosing it.

Completion criterion: every existing desktop and headless model has a recorded
destination, compatibility adapter, or explicit retirement decision. Opus has
received the schema and API changes needed for migration and client work.

## Step 2: Unify the runtime and persistence

Make the headless runtime the server that desktop starts when it hosts locally.
Move catalog, account, profile, progress, session, and policy persistence behind
shared interfaces. Keep the desktop process responsible only for desktop-specific
integration and local playback behavior that cannot live in the server.

Completion criterion: desktop-hosted and standalone server startup resolve the
same services, migrations, state model, route registry, and shutdown behavior.
New behavior has no second implementation in the legacy desktop media server.

## Step 3: Unify the video pipeline

Bring desktop codec probing, metadata construction, direct play, remuxing,
transcoding, subtitle selection, audio selection, HDR planning, hardware probing,
resource limits, and recovery behavior into shared server code. Preserve catalog
records while a source is unavailable or partly unreadable.

Completion criterion: every supported client capability produces one explainable
playback plan from the same probed media facts. Direct, remux, and transcode paths
use the selected audio and subtitle tracks. Hardware failure reaches a bounded
software fallback or a typed capacity error.

## Step 4: Add canonical pairing and compatibility

Add secure discovery, approval, device credentials, revocation, and certificate
pinning support to `/api/v1`. Keep only the legacy routes required for the agreed
compatibility window. Point each legacy route at canonical services.

Completion criterion: the legacy adapter contains no independent account,
profile, catalog, or playback state. A revoked device loses authentication and
playback authority through both route generations.

## Step 5: Complete server-side remote features

Implement local and remote request classification, `remote.access` enforcement,
TLS lifecycle, trusted-proxy policy, rate limits, audit events, invitation scopes,
offline-download leases, storage quotas, expiry, and revocation. Provide the
contracts Opus needs for client downloads, casting, devices, and sharing.

Completion criterion: every credential, API, artwork, direct-media, transcode,
download, invitation, and session route has an explicit local and remote policy.
Remote access is denied until enabled. Revocation blocks new access immediately.

## Step 6: Static completion review

Trace startup, migration hooks, shutdown, backup, restore, scan, playback,
revocation, and source-loss paths across both deployment modes. Inspect every
modified trust boundary and all compatibility adapters.

Completion criterion: every owned-file change appears in a handoff ledger with
its contract impact and verification status. No documentation claims runtime or
device evidence that has not been produced.

## Handoff format

Report:

1. Changed paths
2. Canonical contracts added or changed
3. Legacy behavior retained and its removal condition
4. Migration requirements sent to Opus
5. Client requirements sent to Opus
6. Security and data-loss risks still open
7. Runtime and device verification still required
