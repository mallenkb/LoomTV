# Optional Stremio Service playback

The desktop's managed torrent engine is separate from this legacy external-service adapter, which remains for its integration fixtures. This page documents only that adapter; its test results do not verify the managed engine.

Implemented October 22, 2026. After user authorization, 32 targeted tests passed: 13 protocol tests, 15 desktop tests and four controlled service integration tests. Real Stremio torrent playback and visual verification have not been performed; the local service was unavailable when checked.

LoomTV connects to the separately installed official Stremio Service, or the service running inside Stremio Desktop, at `http://127.0.0.1:11470`. It does not bundle, download or launch `server.js`, install a replacement torrent engine, or modify Stremio settings.

## User flow

Torrent sources appear with a Choose file action. The source picker offers a service check and a link to the official service installer. The user allows torrent connections for the current selection before requesting metadata. This can start peer activity, even before playback begins.

The host checks `/settings`, reports the server version, and requests `/{infoHash}/create`. It validates the returned hash and file list. A successful version check establishes API availability, not the identity of the local process or proven playback compatibility.

The file picker preserves the torrent's original indexes. It marks a valid provider selection, warns about obvious IMDb episode/filename conflicts, and never automatically plays the largest file. Anime, specials and ambiguous filenames remain explicit user choices. The selected reference retains the provider target, profile and add-on revision.

Selected video bytes pass through LoomTV's existing token-protected relay to the native VLC or mpv player. The service URL, torrent hash and tracker information stay in the host. Browser conversion, torrent-file URL downloads, base32 magnets, BitTorrent v2-only sources, DASH, Usenet and archive extraction are outside this first milestone.

## Boundaries and lifecycle

- Stremio requests use only the fixed IPv4 loopback endpoint. Redirects, arbitrary service URLs, remote engine options, filesystem paths and inherited provider credentials are not accepted.
- Metadata has byte, file-count and time limits. Torrent preparations are cancellable and bounded. Profile changes and add-on revocation invalidate pending preparations and playback sessions.
- Tracker syntax and initial DNS destinations are checked. Stremio owns subsequent tracker, DHT, peer and filesystem activity. These checks do not sandbox the independently installed service or pin its later DNS lookups.
- Closing playback closes LoomTV's upstream streams. It does not guarantee that the shared service stops uploading, downloading or retaining cache. LoomTV does not call remove/removeAll or shut down Stremio, because those operations can disrupt other clients.
- Cache, upload, peer connection and background-transfer policies remain Stremio settings. LoomTV limits its own metadata requests, relay transfers and sessions; it cannot impose process-wide limits on the shared service.
- No torrent starts from browsing or an automatic HTTPS fallback. Torrent playback is opt-in in the source picker.

## Verification still required

The passing tests cover mixed HTTPS/torrent sources, rejected references, service detection, original file indexes, episode conflicts, controlled byte-range transfers through the relay, cancellation, profile revocation, metadata bounds and redirect rejection. The service fixture uses an ephemeral loopback port and never contacts torrent peers or the actual Stremio endpoint. Its synthetic media bytes verify transport, not video decoding.

Before treating the integration as release-ready, verify actual downloading, single-file and season-pack playback, seeking, stalls, codec failures, and coexistence with Stremio Desktop against the installed service. Include packaged-app checks with controlled media and the user's background-window restrictions. These remain unverified while the service is unavailable.

API references: [Stremio core requests](https://github.com/Stremio/stremio-core/blob/development/src/types/streaming_server/request.rs), [settings response](https://github.com/Stremio/stremio-core/blob/development/src/types/streaming_server/response.rs), [EngineFS routes](https://github.com/Stremio/enginefs/blob/master/enginefs.js), [official installer](https://www.stremio.com/download-service).
