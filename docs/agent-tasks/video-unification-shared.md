# LoomTV video unification program

Read this document before work that changes LoomTV server ownership, persistence,
accounts, migration, clients, releases, remote access, downloads, casting, or
private sharing.

## Objective

Turn the existing desktop, headless, browser, and mobile implementations into one
self-hosted video product without losing existing user data.

The active product scope is video. It includes movies, television series, anime,
home videos, and other owned or authorized video. Music, photos, books, podcasts,
radio, and live television remain outside this program.

## Product contract

- One canonical server runs standalone on a NAS or inside the desktop app.
- `/api/v1` is the canonical client contract.
- Accounts control authentication and authority.
- Adult, Child, and Guest profiles control viewing identity and personal state.
- One owner account is always present. The owner may delegate administration.
- Desktop, browser, mobile, and television clients connect directly to the same
  server contract.
- Direct play is preferred. Remux or transcode only when the client requires it.
- Original media remains read-only unless an administrator enables and confirms
  a destructive operation.
- Remote access defaults to disabled.
- Analytics, advertising identifiers, and watch-history uploads remain absent.
- Core self-hosted behavior remains available without a subscription.

## Program invariants

### Migration

Every state-changing migration must support a dry run, create a verified backup,
write an operator-readable report, and roll back after failure. Re-running a
completed migration must not duplicate or discard data.

Migration covers every existing library root, media item, metadata override,
artwork reference, account, profile, PIN, progress record, history entry, list,
and preference. A changed mount path or filename must not silently discard
identity when stronger evidence links the item to its prior record.

### Compatibility

The canonical server supports the current client generation and one prior client
generation. Legacy `/api/v2` routes may remain as temporary adapters. New product
behavior belongs in `/api/v1` and shared server code.

### Security

Non-loopback cleartext transport fails closed. Direct TLS and an explicitly
trusted TLS proxy are supported. Server code classifies local and remote access
before enforcing account, library, device, download, and remote-access policy.

Secrets remain outside renderer-visible settings. Logs and reports omit secrets,
tokens, PINs, raw library paths, and certificate private material.

### Verification

Repository instructions prohibit tests unless the user explicitly requests them.
Use static inspection, parsers, type-aware editor checks, schema comparison, and
targeted source review. Report each runtime, device, signing, accessibility, and
migration claim that still requires execution.

Code completion is not permission to claim product completion. Use these labels:

- Implemented
- Statically verified
- Runtime verification required
- Device or platform verification required

## Working tree and ownership

Preserve existing user changes. In particular, `apps/mobile/app.json` was already
modified before this program. Treat it as user-owned unless a reviewed change is
required. The existing design QA files are also outside this program.

Sol owns server and shared-core files. Opus owns client, migration, documentation,
and release files. The task briefs list exact paths. When a change crosses that
boundary, send the proposed contract and required file delta to the owner. The
owner applies the edit.

## Coordination protocol

1. Read this document and the assigned task brief completely.
2. Inspect the owned paths and list material differences from this contract.
3. Send contract changes to the other agent before editing dependent code.
4. Complete one coherent tranche at a time.
5. After each tranche, report changed paths, new contracts, compatibility impact,
   unresolved risks, and verification still required.
6. Before handoff, account for every modified model, route, state record, and
   user-visible behavior in the completion report.

## Program completion

The program is implementation-complete only when all five conditions hold:

1. Documentation and release rules describe the shipped product without known
   contradictions.
2. Desktop-hosted and NAS-hosted LoomTV use one server, API, persistence model,
   account model, and playback planner.
3. Existing installations migrate without rebuilding libraries or losing user
   state, with dry-run and rollback paths present.
4. Desktop, browser, mobile, and television clients implement the required video
   journey through the canonical API.
5. Remote access, offline downloads, casting, invitations, and private sharing
   enforce the agreed security and profile rules.

Runtime-complete status requires the separate verification matrix. Keep that
status open until the user authorizes tests and the required devices, NAS hosts,
GPUs, browsers, and signed artifacts have produced evidence.
