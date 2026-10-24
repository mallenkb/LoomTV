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
- Valid BitTorrent v1 hashes and hex-hash magnets retain a bounded host-only
  torrent descriptor with `availability: "requires-engine"` and
  `requiresExplicitConsent: true`. They are not counted as verified or directly
  playable. Desktop resolves them through its managed torrent engine.
- A valid direct HTTPS media URL takes precedence over accompanying torrent
  metadata. Torrent-file URLs without a supported hash and other peer-to-peer
  transports remain rejected with an explanation.
- The protocol adapter itself never starts an engine. The desktop source picker
  requires an explicit torrent action before the host starts peer discovery.

HTTP, local-file, `data:`, `javascript:`, `ftp:`, and other unsafe or
unsupported source URLs are returned as `sourceKind: "unsupported"` with
`availability: "rejected"` and a reason code. A client should render the
consent prompt only for the explicit `requires-engine` classification, so a
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

[`packages/stremio-adapter/examples/stremio-trusted-addon.manifest.json`](../packages/stremio-adapter/examples/stremio-trusted-addon.manifest.json)
is a small HTTPS-only manifest example. It declares all four supported
resources, one movie catalog, and `p2p: false`. It is a declaration fixture,
not a bundled provider or a source allow-list; the user must still review and
approve the actual HTTPS manifest URL before use.

## Integration status

The adapter is re-exported from `packages/stremio-adapter/src/index.mjs`, has a
direct package export and TypeScript declarations, and exposes the manifest
schema at `@loom-media-server/stremio-adapter/stremio-schema`. Persisted
snapshots use a canonical raw manifest subset and are regenerated through the
strict normalizer on load; derived adapter fields and request-scoped consent
are not trusted as persisted input.

The desktop host imports this package through `stremioPluginService.ts`,
`stremioPluginServiceDesktop.ts`, and `stremioPluginWire.ts`. Settings installation,
catalog browsing, metadata details, source selection, and subtitle lookup use the
host integration. The following section describes its playback grants and relay.

The unused Loom-native marketplace, identity, executable-runtime, signing, and
downstream contract modules have been removed. The Stremio adapter implementation,
manifest schema, example, and its two existing regression suites are preserved.
Registry snapshots and user-installed add-ons need no migration for the package
rename. This cleanup does not change native playback engines.

## Desktop playback sessions (October 22, 2026)

The desktop integration now exchanges `addon://stream/<opaque token>` references
for playable addon sources, including streams embedded in metadata and the
Archive.org resolver. Provider media URLs and supported request headers remain
in the main process. The host binds each grant to the selected profile, profile
selection revision, addon approval and configuration revision. Disabling,
removing, reconfiguring or switching profiles invalidates affected grants and
stops active playback. Reload the source list after access changes or expiry.

Both native players use the existing media server's loopback-only relay. Browser
fallback uses the same relay, with host-side detection for extensionless HLS.
Source headers are bounded and allowlisted, and are sent only to their original
origin. Every upstream request and redirect validates a public HTTPS destination
and pins its resolved address. Media streams use backpressure, bounded playlist
buffers and downstream cancellation. Provider URLs never become general-purpose
renderer fetch targets. Arbitrary external media URLs are no longer accepted by
the native playback IPC routes; existing external video-page actions remain.

The relay handles ranged media, HLS variants, alternate renditions, initialization
maps and identity AES-128 keys. Each supported HLS resource is rewritten to a
session-local token. DRM, variable substitution, content steering, LL-HLS and
unrecognized HLS extensions are rejected. It does not add transcoding or browser
codec support. There are four concurrent sessions, a six-hour grant/session
lifetime, a 30-minute idle timeout, a 1 MiB playlist limit, 8,192 distinct resources
per session, twelve concurrent requests and 1,200 requests per minute. Long live
streams can reach the resource limit and require restarting playback. Native
engine disposal releases its lease; browser cleanup closes its source sessions.

Regression cases were added for grant revocation, profile changes, session reuse,
idle expiry and HLS rewriting. Tests and runtime/visual playback verification have
not been run for this implementation, at the user's request. Static typechecking
covers the desktop and protocol declarations. Earlier integration-status notes
above describe the original adapter-only milestone.

## Configuration and source selection

Configurable providers now have a **Configure in browser** action. The owner-only
host derives `/configure` from the stored manifest endpoint, preserving its path
and query. The renderer receives no configured URL from this action. After using
the provider page, paste its manifest link into the URL input and review it.
The returned manifest must retain the selected addon identity and requires a new
approval. A provider that still declares required configuration without usable
form fields remains blocked. Existing host-rendered configuration forms remain
available. Unknown manifest fields continue to be dropped with compatibility
warnings; they cannot add permissions or executable behavior.

The source picker shows each provider as loading, ready, empty or failed, in a
stable order. Up to four requests run at once. Results appear as each provider
finishes, so a slow provider does not delay usable sources. Request IDs are scoped
to the sending renderer. Closing, refreshing, changing the target or changing the
profile cancels pending stream requests and discards old results. Cancellation
also reaches the existing host request queue and transport.

Before selection, the picker checks the provider revision and asks the host to
validate the playback grant. Expired grants reload the source list, including
inline metadata streams, and ask the user to select again. Playback start still
performs its own authorization check. An upstream 401, 403 or 410 also revokes
the refused source, so selecting it again requests fresh sources. There is no automatic provider substitution
or network probing while browsing the catalog.

This phase was checked by static TypeScript and lint inspection. Regression cases
were added for configured endpoints, fresh approval, request cancellation and
expired selections. Tests, live-provider configuration and runtime/visual playback
checks remain unrun at the user's request.

Desktop manages torrent sources with host-owned WebTorrent workers, explicit file selection, and the existing native playback relay. Browser torrent playback remains unsupported.
