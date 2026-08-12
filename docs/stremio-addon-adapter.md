# Stremio add-on adapter

The LoomTV Stremio adapter is a bounded, normalization-only client for the
safe subset of the Stremio v3 add-on protocol. It lets a user review and
install an HTTPS manifest URL, then turns compatible catalog, metadata, stream,
and subtitle responses into Loom-owned candidate objects. It does not run
remote JavaScript, load an Electron/Node plug-in, start a torrent client, or
make playback or authorization decisions.

The adapter follows the Stremio protocol's manifest and resource conventions:
the manifest is fetched from HTTPS and resource requests use paths such as
`/catalog/{type}/{id}.json`, `/meta/{type}/{id}.json`,
`/stream/{type}/{videoId}.json`, and `/subtitles/{type}/{videoId}.json`.
See the [Stremio add-on protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html),
[manifest response](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html),
[stream response](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html),
and [subtitle response](https://stremio.github.io/stremio-addon-sdk/api/responses/subtitles.html)
references for the upstream shapes.

## Install trust boundary

Installation is user-initiated and has two distinct steps:

1. `reviewManifestUrl(url)` accepts only a public HTTPS manifest URL, fetches a
   bounded JSON document, and strictly validates the supported manifest subset.
   The resulting record is persisted as `pending-review` with `trusted: false`.
   A review is not an enable action.
2. The client shows the normalized identity, version, description, declared
   resources, catalog types, and review warnings. Only
   `approve(addonId, { confirmed: true, reviewToken: review.reviewToken })`
   changes the record to `state: "enabled"` and `trusted: true`. The review
   token binds approval to the exact review currently shown by the client, so
   a stale approval cannot enable a later manifest review for the same ID.

The registry persists the install state, reviewed manifest, source URL, review
token, and timestamps through `toJSON()`/`serializeStremioAddonState()`.
`disable(id)`
sets `state: "disabled"` and clears trust; it does not delete the review
record. `remove(id)` deletes the record. A disabled add-on must be explicitly
approved again before resource requests are allowed. Persisted state is
validated before it is loaded. The caller should store snapshots in Loom-owned,
profile-bound storage; this adapter validates shape and trust invariants but
does not provide cryptographic storage integrity by itself.

The manifest URL and all derived endpoints must be HTTPS. The adapter rejects
credentials, fragments, local/private/single-label hosts, unsafe redirects,
and non-2xx or malformed responses. It sends no credentials or cookies and
does not follow redirects. Arbitrary install URLs are never silently treated as
trusted.

## Supported normalized resources

Only these Stremio resources are accepted, and each request must be declared
by the installed manifest:

| Stremio resource | Loom-owned result | Boundary |
| --- | --- | --- |
| `catalog` | `resource: "catalog"`, bounded `items` | Catalog `metas` become metadata candidates. |
| `meta` | `resource: "meta"`, nullable `item` | Metadata fields and embedded episode data are allow-listed and normalized. |
| `stream` | `resource: "stream"`, `sources` plus counts | Every source is classified; unsafe and unsupported sources remain visible as rejected candidates. |
| `subtitles` | `resource: "subtitles"`, safe `subtitles` plus rejections | Only HTTPS subtitle URLs become candidates. |

Unknown manifest fields, unsupported resources, malformed required fields,
unsafe optional artwork URLs, malformed response objects, and oversized arrays
are rejected with safe, path-aware adapter errors. Unsupported Stremio response
features such as YouTube IDs, external web pages, archive/file-selection
sources, and non-HTTPS media are not executed or opened.

## Source classification and consent

Direct HTTPS media is returned as `sourceKind: "https-media"`. A URL whose
path ends in `.m3u8` is classified as `sourceKind: "hls"`. These are the only
sources marked `availability: "playable"` and `playableByLoom: true`; that flag
means transport-eligible candidate data, not final authorization. Every
candidate carries `requiresLoomAuthorization: true`, and Loom's existing
server and player still decide whether and how to play it.

Torrent and peer-to-peer results are deliberately **not silently hidden**:

- `magnet:` URLs and `infoHash` values are classified as
  `sourceKind: "torrent"`.
- Peer-discovery fields such as non-empty `sources`/`servers` are classified as
  `sourceKind: "peer-to-peer"`. Torrent file URLs and `fileIdx` are classified
  as `sourceKind: "torrent"`; archive/NZB/file-selection fields remain
  unsupported/rejected rather than being mislabeled as peer-to-peer.
- The normalized result includes `availability: "consent-required"`,
  `requiresExplicitConsent: true`, `consentPrompt.required: true`,
  `consentPrompt.persisted: false`, a source-kind-specific reason, and a safe
  reference where available.
- No torrent or peer-to-peer source is playable by Loom. There is no torrent
  engine, peer downloader, or acquisition automation in this adapter.
- A client may pass an explicit, per-request acknowledgement such as
  `peerToPeerConsent: { granted: true, acknowledgedSourceKind: "torrent" }`.
  That changes the classification to `consent-granted` for that response only;
  `consentPrompt.required` becomes false for that response, it does not persist
  consent, and it still does not make the source playable.

HTTP, local-file, `data:`, `javascript:`, `ftp:`, and other unsafe or
unsupported source URLs are returned as `sourceKind: "unsupported"` with
`availability: "rejected"` and a reason code. A client should render the
consent prompt only for the explicit `consent-required` classification, so a
user can decline or opt in with full awareness of the source type.

## Network bounds and Loom authority

The default request limits are an 8-second timeout, 256 KiB manifest body,
1 MiB response body, 200 items, 4,096-character strings/URLs, and 16 request
extra entries. Configuration is bounded by hard ceilings of 30 seconds, 1 MiB
manifest, 4 MiB response, 1,000 items, 16 KiB strings, 8,192-character URLs,
and 32 extra entries. Responses are size-checked while being read, parsed as
JSON, and shape-validated before normalization. Resource routes are derived
relative to the reviewed manifest path and preserve its query parameters for
configured add-on URLs.

The adapter returns candidates only. Loom's media server remains authoritative
for profile and device access, signed-stream issuance, sharing, authorization,
direct-play versus transcode choice, local-file policy, and final playback.
An add-on cannot bypass those controls by returning a URL or a P2P reference.

## Safe example

[`packages/plugin-protocol/examples/stremio-trusted-addon.manifest.json`](../packages/plugin-protocol/examples/stremio-trusted-addon.manifest.json)
is a small HTTPS-only manifest example. It declares all four supported
resources, one movie catalog, and `p2p: false`. It is a declaration fixture,
not a bundled provider or a source allow-list; the user must still review and
approve the actual HTTPS manifest URL before use.

## Integration status

The adapter is re-exported from `packages/plugin-protocol/src/index.mjs`, has a
direct package export and TypeScript declarations, and exposes the manifest
schema at `@loom-media-server/plugin-protocol/stremio-schema`. Persisted
snapshots use a canonical raw manifest subset and are regenerated through the
strict normalizer on load; derived adapter fields and request-scoped consent
are not trusted as persisted input.

Static checks performed for this additive layer were JavaScript syntax checks,
the package TypeScript declaration check, JSON parsing of the schema/examples,
and a targeted fake-HTTPS lifecycle check covering review, approval, fetch,
normalization, ephemeral consent, persistence, disable, and removal. Tests,
renderer/UI wiring, playback changes, torrent support, and LibVLC changes were
not performed.

No renderer, UI, playback, torrent, or LibVLC integration is implied by this
adapter layer. A future UI integration should treat `pending-review`,
`disabled`, `consent-required`, and `rejected` as explicit states rather than
filtering them into an apparently empty provider result.
