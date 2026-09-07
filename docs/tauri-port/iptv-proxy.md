# IPTV streaming proxy

`crates/loomtv-core/src/iptv_proxy.rs` supplies the upstream half of local IPTV playback. The Tauri loopback server remains responsible for route credentials, signed child-resource URLs, HLS rewriting, response construction, and client-facing status codes.

Create one `IptvProxy` with the runtime's shared `Arc<tokio::sync::Mutex<Store>>`. `resolve_reference` accepts renderer references in the form `iptv://channel/{sourceId}/{channelId}`. A `format=direct` query selects direct playback; every other value keeps the HLS default. The method resolves only stored channels and returns the upstream HTTPS URL with an `IptvPlaybackScope` containing the active profile ID and selection revision.

IPTV remains available to every unlocked active profile, including Kids profiles, matching the Electron desktop behavior. Live TV channels have no rating metadata to evaluate. The loopback layer must retain the returned scope in each signed HLS child resource. `validate_scope` rejects a root or child after the profile selection changes. `fetch` also validates the scope before and after every upstream request.

`fetch(scope, upstreamUrl, method, range)` accepts `GET` and `HEAD`, plus one optional `bytes` range. It returns `IptvProxyResponse` with the final redirect URL, upstream status, a filtered header map, and an `IptvProxyBody`. The permitted response headers are `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges`; the loopback layer must replace `Content-Length` after any HLS rewrite and add its own `Cache-Control` and `X-Content-Type-Options` headers. `IptvProxyResponse::is_hls_playlist` recognizes the same content types, URL suffixes, and `#EXTM3U` body prefix as Electron. The method may read and retain an initial chunk for format detection.

`IptvProxyBody::next_chunk` relays direct streams and HLS media resources without a total body-size or lifetime ceiling. The body owns its concurrency permit until completion or cancellation, applies a 30 second idle-read timeout, and checks the captured profile before and after every chunk. `read_manifest` is reserved for HLS playlists and enforces a 4 MiB cap before the parent rewrites its URIs.

`resolve_hls_reference(reference, playlistUrl)` resolves relative playlist URIs against the final upstream URL. It returns HTTPS media URLs for the parent's signed-resource registry, rejects plain HTTP, and leaves data or unsupported schemes unchanged by returning `None`.

Every upstream request re-resolves the current hostname, denies private, reserved, or mixed DNS answers, and pins the validated address set into a new no-proxy reqwest client. Rustls still checks the provider hostname and public CA chain. Redirects repeat the URL and DNS policy. Establishing a stream uses a 30 second network timeout and a 90 second redirect-and-retry deadline. An established stream has no lifetime ceiling; idle reads still time out after 30 seconds. The proxy permits four redirects, one retry for HTTP 429 or server errors, eight concurrent bodies, and 4 MiB buffered manifests. Errors omit upstream URLs and stored channel data.

Single byte ranges are supported. Multipart ranges are rejected so one loopback request cannot amplify memory use across a large multipart response. The Electron proxy forwards multipart ranges, but LoomTV's browser playback paths request single ranges.

No tests, network requests, application launches, database reads, or credential access were performed while adding this module.
