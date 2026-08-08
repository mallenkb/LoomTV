# Plugin Phase 4–9 contract: pre-phase design scaffolding

This worktree records safe downstream contracts after reviewing the Phase 0–3
foundation at `4e0093b` (parent of `017ae94`). It is a design and validation
layer, not Phase 4–8 completion: no provider runtime, proxy route, artifact
fetch, install, profile mutation, artwork mutation, or executable enablement is
implemented here.

## Phase 0–3 dependency gates

| Gate | Evidence reviewed | Status for downstream enablement |
| --- | --- | --- |
| G0 — declaration identity and explicit approval | `plugin-manifest.v1`, reverse-DNS add-on IDs, capability allowlist, `StremioAddonRegistry`, pending-review state, and explicit review-token approval | Met in the existing foundation |
| G1 — provider egress | Bounded HTTPS adapter responses and host `safeFetch` guard exist; complete origin, redirect, DNS/rebinding, and per-surface policy is not a settled shared contract | Open; raw source resolution and proxying remain blocked |
| G2 — profile/pairing revocation | Owner-only management, explicit standard-profile grants, Kids/Guest denial, selection-revision checks, and persisted-state revalidation exist; signed capability revocation and every in-flight sharing path still need review | Open; wire callers cannot supply profile or revalidation claims |
| G3 — artwork/metadata boundary | Artwork and shared-library mutations remain owner-only; artwork routes need their separate restriction/LAN review | Open; only opaque `artworkRef` crosses a downstream contract |
| G4 — subtitle attachment | Wire, verified, authorized, plan, and receipt shapes exist | Blocked until a host-owned bounded fetch/cache/attachment path is reviewed |
| G5 — playback ticket/proxy | Wire, verified, authorized, proxy-plan, and future ticket shapes exist; no destination resolver or proxy route exists | Blocked until G1–G3 and a media proxy policy are complete |
| G6 — discovery/search | Add-on/type/provider item identity and catalog-only membership are defined with a legacy migration | Scaffolded; no library import or runtime search adapter exists |
| G7 — Desktop/Headless parity | A descriptor covers the same host surfaces and explicitly marks scaffolded/blocked states | Design-only; neither runtime is made to execute plugins |
| G8 — signed marketplace/catalog/update trust | JCS-compatible domain-separated bytes, exact Ed25519 lengths, publisher/key lifecycle fields, sequence/rollback/review/revocation, and renderer-safe projections are modeled | Design-only; host key storage, network retrieval, and staging are absent |
| G9 — executable sandbox | Threat model, evidence checklist, runtime lifecycle vocabulary, and update quarantine are recorded | Blocked; no executable artifact may be enabled |

The current Phase 0–3 adapter may normalize provider HTTPS candidates
internally. Those values remain behind its reviewed host boundary and are not
accepted by these downstream DTOs.

## Trust pipeline

Every downstream request follows this one-way shape:

```text
untrusted wire DTO
    -> strict parser (no profile/authorization/revalidation/raw transport fields)
    -> host verification against a verified marketplace add-on
    -> host authorization snapshot (mandatory for search, subtitle, playback)
    -> host-only plan or future runtime ticket
```

`parseWire*` functions produce frozen data-shaped values. Verification and
authorization are branded with private `WeakMap` records; copying their
properties cannot manufacture a host value. The host authorization context is
created from the host’s current device/profile/selection/authorization snapshot
and add-on capability grants. A renderer or provider cannot provide those
claims. Authorization output contains a host binding and epoch, not booleans
such as `profileBound` or `pairingRevalidated`.

## Safe downstream surfaces

### Subtitle attachment

`parseWireSubtitleAttachmentRequest` accepts only an add-on ID, opaque media and
subtitle references, a correlation reference, and bounded presentation data.
The host verifies the add-on’s subtitle capability and then authorizes it with a
mandatory host context. The resulting plan still says
`host-resolution-required`; a receipt can carry only an opaque attachment
reference or reason code. No subtitle URL, path, caller profile, or caller
revalidation claim is admitted.

### Playback ticket/proxy

`parseWirePlaybackTicketRequest` accepts only opaque references and the already
reviewed `https-media`/`hls` source kinds. An authorized request can become a
`playback-proxy-plan`, never a playable URL. The future host ticket requires a
branded runtime lease in `ready` state, is short-lived, denies redirects, and
requires authorization re-check at use. There is no proxy implementation in
this phase.

### Discovery/search and identity

Search namespaces identify an add-on and catalog membership. Catalog item keys
are derived only from the Plugin 0–3-compatible tuple
`(addonId, type, providerId)`. The catalog is represented separately as
membership, so the same provider item has one canonical key across catalogs.
`migrateLegacyCatalogItemIdentity` maps the prior catalog-scoped key and keeps
the old catalog membership for persistence migration; it does not silently
merge unrelated provider IDs.

### Marketplace, catalogs, and updates

The signed host marketplace/index models publisher and key IDs, add-on identity,
manifest origin, declared capabilities, risk flags, review state, revocation,
key transitions, sequence rollback, and catalog memberships. Verification is
host-owned and checks publisher trust, exact Ed25519 material, expiry, sequence,
rollback approval, and key-transition proof. Renderer projections omit
publisher keys, signatures, manifest origins, transition proof, rollback
internals, and artifact references.

Signed catalogs bind a verified publisher/add-on to the catalog identity and
the canonical catalog payload; the derived `itemKey` is recomputed after
validation and is not an unsigned wire field. Signed updates carry an opaque artifact
reference, digest, size, review/revocation/rollback metadata, and an explicit
artifact kind. `executable-plugin` updates verify only into
`quarantined-phase9` with `installable: false` and
`PHASE9_SANDBOX_REQUIRED`; no authorization function can stage them.

Signing bytes are normative: UTF-8 of
`LoomTV-Plugin-Signature/v1\0<domain>\0` followed by the reviewed
JCS/RFC8785-compatible canonical JSON payload. Domains are separate for the
marketplace index, catalog, and update. Signatures decode from canonical
unpadded base64url and must be exactly 64 bytes; public keys must be exactly 32
bytes. Fixed vectors live in `src/signed-bytes.mjs` and semantic checks live in
the test source, but tests are intentionally not run in this worktree pass.

### Headless parity and runtime lifecycle

`plugin-host-parity` is a portable description, not a runtime assertion. Every
surface must be marked `available`, `scaffolded`, or `blocked`, and the
descriptor is scoped as `pre-phase-scaffold`.

The future Phase 5 implementation must reuse the corrected lifecycle in
`runtime-lifecycle.mjs`:

```text
absent -> starting -> ready -> draining -> stopped
             |          |         |
             v          v         v
           failed     failed    revoked
```

`ready` is the only state eligible for future ticket issuance. Selection or
authorization revocation must force draining/revoked behavior, stale epochs
must fail closed, and a restart/update must not bypass the lifecycle. No Phase
5 runtime is claimed here.

## Explicitly out of scope

- raw provider, subtitle, artwork, playback, proxy, manifest, or artifact URLs;
- filesystem paths, commands, executable entrypoints, install scripts, or
  arbitrary provider JavaScript/native modules;
- renderer-controlled profile, pairing, approval, or revalidation claims;
- provider fetch, DNS resolution, redirects, HLS segment routing, or media IPC;
- catalog import into local library identity or shared metadata mutation;
- publisher-key discovery, artifact download, package installation, or restart;
- Desktop/Headless runtime integration and Phase 4–8 feature completion;
- moving `executable.sandbox` out of `blocked` before the Phase 9 evidence gate.

The executable threat model and machine-readable evidence ledger are maintained
in `docs/plugin-sandbox-threat-model.md` and
`security/plugin-sandbox-threat-model.json`.
