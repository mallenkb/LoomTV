# Plugin Phase 4–9 contract and dependency gates

This document records the boundary reviewed before extending the plugin
foundation. Phase 4–9 work in this branch is contract scaffolding only: it
does not fetch a provider source, expose a raw URL, launch a process, install
an artifact, or bypass the existing profile/artwork/network gates.

## Phase 0–3 contract reviewed

The current foundation at `4e0093b` provides the following host boundary:

| Boundary | Existing contract | Phase 4–9 consequence |
| --- | --- | --- |
| Manifest identity | `plugin-manifest.v1` requires a reverse-DNS ID, compatible Loom API range, and an explicit capability allowlist. | Downstream objects retain the plugin ID and reject unknown fields. |
| Install and trust | `StremioAddonRegistry` reviews a declaration into `pending-review`; only an explicit current review-token approval creates an enabled/trusted record. | No downstream object changes install state or trust. |
| Provider egress | The Stremio adapter accepts bounded HTTPS JSON responses, rejects private/local/single-label hosts, bounds response size/time, and delegates desktop requests to `safeFetch`. | New contracts carry opaque references only. A host must resolve a reference through the already-reviewed egress policy. |
| Provider behavior | Add-on code is not loaded. Stremio resources are read as JSON declarations/responses; torrent and peer-to-peer stream candidates are rejected. | Playback contracts allow only `https-media` and `hls` source kinds, with no P2P or executable source. |
| Profile authorization | Desktop management is Owner-only; standard profiles need an explicit grant; Kids and Guest profiles are denied; desktop requests re-check profile selection revision after the provider request. | Subtitle and playback contracts require a profile binding and mandate selection, pairing, and approval revalidation. |
| Renderer boundary | The desktop renderer receives validated IPC methods, not a provider runtime. Discovery is metadata/catalog preview only. | Search namespaces and host tickets are safe data contracts, not renderer-controlled transport endpoints. |
| Persistence | Add-on state and profile access are revalidated when loaded; disabling/removing/replacing an add-on revokes profile grants. | Signed sequence numbers and expiry are included for future catalog/update consumers. |

The current adapter still has internal normalized source/subtitle candidates
that contain provider HTTPS URLs. Those values remain an implementation detail
of the Phase 0–3 adapter and are deliberately not accepted by the downstream
constructors in `packages/plugin-protocol/src/downstream.mjs`.

## Dependency gates

These are the gates that must be satisfied before a downstream surface becomes
an enabled host feature. “Scaffolded” means the data shape exists; it is not a
claim that the runtime is safe or complete.

| Gate | Status | Evidence or blocker |
| --- | --- | --- |
| G0 — declaration validation and explicit approval | Met for the current foundation | `plugin-manifest.v1`, `StremioAddonRegistry`, persisted-state validation, and review-token approval are present. |
| G1 — complete provider egress policy | Open | The current adapter has bounded HTTPS checks and a host fetch guard, but the full origin/redirect/DNS policy is not a settled contract for every provider. Do not widen fetch or proxy behavior from this branch. |
| G2 — profile and pairing revocation | Open | Selection revision checks exist in the desktop plugin service, but the broader LAN audit still identifies signed capability revocation and in-flight sharing/profile enforcement work. A downstream ticket must not be treated as authorization by itself. |
| G3 — artwork and metadata boundary | Open | Artwork/metadata edits are shared-library mutations and remain owner-only. Existing artwork routes still require their separate restriction and LAN review; downstream contracts expose only an `artworkRef`, never an image URL or file path. |
| G4 — host-mediated subtitle attachment | Scaffolded, blocked for enablement | `subtitle-attachment-request` and `subtitle-attachment-receipt` exist. A host still needs a profile-bound, size-bounded subtitle fetch/cache path and a local attachment resolver before UI or playback wiring. |
| G5 — host-mediated playback proxy | Scaffolded, blocked for enablement | `playback-ticket-request` and `playback-ticket` describe opaque, short-lived, range-capable tickets. No proxy route, raw URL resolver, HLS segment policy, or media IPC is added here. G1–G3 remain prerequisites. |
| G6 — discovery/search namespacing | Scaffolded | Catalog/search keys use a `loom-plugin:` namespace and carry provider identity. No catalog item is merged into the local library identity space by these helpers. |
| G7 — headless parity | Scaffolded | `plugin-host-parity` describes the same host surfaces for Desktop and Headless runtimes. The headless server is not made to fetch or execute plugins by this branch. |
| G8 — signed catalog/update trust | Design-only | Ed25519-shaped envelopes, canonical JSON, expiry, digest, sequence, and pinned-publisher requirements are specified. Key distribution, rotation, revocation, and host artifact retrieval are not implemented. |
| G9 — executable plugin sandbox | Blocked | The repository has no plugin executable runtime. The threat model below requires a separate process, package verification, capability broker, resource limits, and kill/revoke semantics before implementation can be considered. |

## Safe downstream surfaces in this branch

### Subtitle attachment

`createSubtitleAttachmentRequest` names a plugin, media, subtitle candidate,
paired-device/profile binding, selection revision, and short validity window.
The candidate is an opaque `subtitleRef`; there is no `url`, path, or host
filesystem location.
The receipt returns either an opaque `attachmentRef` or a bounded reason code.
The host remains responsible for source resolution, content limits, caching,
format handling, profile checks, and revocation.

### Playback ticket/proxy

`createPlaybackTicketRequest` accepts only an opaque `sourceRef`, a
paired-device/profile binding, and the two source kinds already recognized by
the adapter: `https-media` and `hls`.
`createPlaybackTicket` describes host-controlled GET/HEAD range delivery with
redirect denial, no-store caching, and profile/pairing/approval revalidation.
It does not produce a proxy URL or a playable source. A later implementation
must resolve the source inside the host and keep that resolution out of the
renderer/client contract.

### Discovery/search namespacing

`createPluginSearchNamespace`, `namespacePluginCatalogItem`, and
`createPluginSearchRequest` make provider/catalog identity part of every
discovery key. The namespace is intentionally separate from local media IDs;
catalog results are still remote metadata until a future, separately gated
import contract exists.

### Headless parity

`createPluginHostParityDescriptor` requires all eight declared surfaces and
records `available`, `scaffolded`, or `blocked` plus an optional gate. It is a
portable descriptor for future Desktop/Headless adapters, not a registration
mechanism and not an assertion that both runtimes currently implement a
surface.

### Signed catalogs and updates

The signed envelopes use canonical JSON as the input to a future signature
implementation, include SHA-256 payload/artifact digests, bounded expiry, a
monotonic sequence, a key ID, and a pinned-publisher requirement. Catalog
artwork is an opaque `artworkRef`; update payloads use an opaque `artifactRef`.
The host must obtain bytes through its own reviewed transport and verify the
publisher and digest before staging anything.

## Explicitly out of scope

- direct provider URLs in IPC, LAN payloads, renderer state, or client-facing
  tickets;
- remote artwork fetch/cache changes or shared-library metadata mutation;
- subtitle URL attachment, raw subtitle file paths, or subtitle download
  routes;
- direct playback, HLS segment proxying, redirects, or raw source enablement;
- manifest configuration pages, arbitrary provider JavaScript, or executable
  plugin packages;
- update key discovery, key rotation, artifact download, installation, or
  restart behavior;
- changes to the existing LAN pairing, profile, artwork, or Electron updater
  security implementations.

The executable-plugin threat model is recorded separately in
`docs/plugin-sandbox-threat-model.md` and
`security/plugin-sandbox-threat-model.json` so that a future implementation
has reviewable evidence requirements instead of an implicit trust boundary.
