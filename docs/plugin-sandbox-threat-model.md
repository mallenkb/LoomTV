# Plugin executable sandbox threat model

Status: design artifact only. The current LoomTV plugin runtime is
declaration-only and host-mediated. Phase 9 remains blocked. A signed package,
an approved marketplace entry, or a user approval is not evidence that
untrusted provider code may run inside LoomTV.

The machine-readable control ledger is
`security/plugin-sandbox-threat-model.json`. This document describes the
security boundary and the evidence required before any executable capability
can be enabled.

## Assets and trust boundaries

Protected assets include library paths and media bytes, profile identity and
selection revisions, pairing credentials, artwork/cache data, provider
credentials, marketplace/update keys, host availability, and LoomTV process
integrity. The renderer, headless API, marketplace/index, provider network,
artifact store, plugin package, plugin process, host policy broker, and
filesystem are separate trust domains.

The only acceptable future data path is:

```text
untrusted plugin process
    -> bounded host RPC with opaque references
    -> capability/profile/revocation broker
    -> reviewed egress, cache, subtitle, metadata, or media operation
    -> bounded renderer/headless projection
```

The plugin process must never receive a raw media/artwork/subtitle URL,
filesystem path, profile secret, pairing credential, publisher private key,
update signing key, arbitrary environment, or child-process capability.

## Supply-chain and signed-data controls

The host marketplace/index must bind publisher ID, publisher key ID, add-on ID,
manifest origin, capability declaration, risk, review, revocation, key
transition, sequence, and rollback policy in one signed, domain-separated
document. A catalog is signed separately and is bound to the verified add-on;
catalog membership is not item identity. An update must carry an artifact kind,
digest, size, version, review, revocation, rollback, and publisher continuity.

Signed bytes use the normative domain prefix and reviewed JCS/RFC8785-compatible
canonicalization recorded in `src/signed-bytes.mjs`. The host must reject
non-canonical base64url, Ed25519 signatures that do not decode to exactly 64
bytes, public keys that do not decode to exactly 32 bytes, invalid UTF-16,
undefined/non-finite JSON, domain confusion, expired documents, sequence
regression, unapproved rollback, revoked keys, and failed key-transition proof.

Executable artifact updates remain `quarantined-phase9` even after all signed
checks pass. There is no API that turns that status into an installable value.

## Threats and required controls

| Threat | Required control before enablement |
| --- | --- |
| Publisher impersonation, key theft, or index replay | Pinned publisher keys, trust-store lifecycle, exact signature decode, domain-separated bytes, key transition proof, revocation, expiry, monotonic sequence, rollback approval, and audit evidence |
| Malformed canonicalization or parser differential | Reviewed JCS/RFC8785-compatible implementation, fixed vectors, parser round-trip tests, negative tests for duplicate/unknown/undefined/non-finite/lone-surrogate data, and one verifier implementation at the host boundary |
| Catalog identity collision | Stable `(addonId, type, providerId)` identity, catalog-only membership, explicit migration from the old catalog-scoped key, and negative collision tests |
| Renderer projection leakage | Projection allowlists that omit signatures, key IDs, manifest origins, transition proof, rollback internals, artifact refs, and raw transport data; schema and semantic tests |
| Executable update bypass | Explicit `executable-plugin` kind, `quarantined-phase9` status, `installable: false`, authorization rejection, and a separate Phase 9 gate |
| Sandbox escape or host compromise | Separate OS process or stronger isolation, no renderer privileges, narrow RPC schema, capability broker, parser hardening, resource limits, and a documented kill/revoke path |
| SSRF, DNS rebinding, redirect abuse, or exfiltration | Default-deny egress broker, public-origin policy, DNS/rebinding checks, redirect denial, byte/rate/time budgets, and no plugin-controlled sockets |
| Profile/pairing confused deputy | Host-owned authorization snapshot, mandatory context for search/subtitles/playback, selection and authorization epochs, per-use revalidation, and no caller-supplied identity claims |
| Artwork or media path disclosure | Opaque references only; host resolves paths after containment and restriction checks. Never serialize paths or raw origins into renderer/plugin data |
| Archive bombs, decompression bombs, and package traversal | Size/count/depth limits before extraction, canonical path containment, no symlinks or device files, atomic staging, and quarantine cleanup |
| Resource exhaustion | Per-add-on CPU/memory/process/request quotas, bounded queues and outputs, cancellation, timeouts, backpressure, crash cleanup, and stale-lease revocation |
| Runtime lifecycle race | Phase 5 must reuse `absent → starting → ready → draining → stopped` plus failed/revoked terminal states; ticket issuance only from a branded ready lease; selection/revocation changes drain or revoke |
| Persistence/update abuse | Versioned state validation, least-privilege storage, atomic rollback, publisher continuity, no install hooks, no arbitrary scripts, and disable/remove revocation |
| Desktop/Headless drift | One host policy contract, parity descriptors with explicit blocked/scaffolded states, identical authorization semantics, and separate runtime evidence for each platform |

## Non-negotiable blocked capabilities

Until the Phase 9 evidence gate is satisfied, the runtime must reject:

- arbitrary plugin JavaScript or native modules in the LoomTV process;
- executable package entrypoints, shell commands, child processes, and dynamic
  loading;
- raw URL/path/command fields in downstream contracts;
- plugin-controlled redirects, proxy destinations, DNS resolution, listeners,
  or local sockets;
- direct profile, pairing, provider-key, publisher-private-key, or update-key
  access;
- install/update scripts, package hooks, symlinks, device files, and unsafe
  archive extraction;
- network listeners and unrestricted environment variables;
- executable artifact update staging, even when its signature is valid.

The wire validators enforce the data-level portion of this rule. They are not a
sandbox and must never be described as one.

## Phase 9 evidence gate

`executable.sandbox` may move from `blocked` only after review attaches all of
the following evidence:

1. publisher trust-store, key transition, revocation, rollback, and audit
   behavior;
2. canonicalization/signature vectors and semantic parser/round-trip/negative
   coverage;
3. platform isolation design for macOS, Windows, Linux, and headless deploys;
4. deny-by-default egress broker with redirect, DNS, origin, and quota policy;
5. host authorization evidence for profiles, pairing, artwork, subtitles, and
   playback at every use;
6. archive/package extraction, path containment, native loading, and escape
   testing;
7. lifecycle, quotas, cancellation, crash recovery, stale-capability revoke,
   and atomic rollback evidence;
8. red-team coverage for SSRF, path traversal, archive bombs, output flooding,
   protocol confusion, renderer leakage, key rollback, and host escape;
9. an explicit release decision accepting documented residual risk.

Until then, the supported implementation remains the existing declaration-only,
host-mediated JSON adapter.
