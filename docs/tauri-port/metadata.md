# Metadata provider gateway

`crates/loomtv-core/src/metadata.rs` implements the desktop metadata request boundary used by `metadata:provider-request`. It accepts the renderer's existing tagged request object as `serde_json::Value` and returns the provider JSON unchanged as `serde_json::Value`.

The command layer should keep one `MetadataProviderGateway` in Tauri state. Construct it with `MetadataProviderGateway::new()`, then call `request_metadata_provider(&request, &settings)`. The settings value must come from the trusted desktop settings store after owner credential access. The gateway reads `metadataOfflineMode`, `metadataApiKeys.omdb`, and `metadataApiKeys.tmdb`, with `omdbApiKey` and `tmdbApiKey` as legacy fallbacks. It never accepts credentials in the renderer request.

The supported request objects match `MetadataProviderRequest` in `apps/desktop/src/shared/desktopProtocol.ts`:

- OMDb uses `{ "provider": "omdb", "query": { ... } }` and adds the stored API key.
- TMDB uses `{ "provider": "tmdb", "path": "...", "query": { ... } }`. It adds `language=en-US` when the caller omits a language. JWT-shaped credentials use the bearer header. Other credentials use `api_key`.
- AniList uses `{ "provider": "anilist", "query": "...", "variables": { ... } }` and posts JSON without a credential.

The HTTP client permits HTTPS only, disables proxies and redirects, and contacts fixed provider hosts. On the first request to a host, the gateway resolves every address with a ten second limit. It rejects the whole address set if any result is private, local, reserved, documentation-only, multicast, or otherwise outside the public ranges accepted by the Electron `safeFetch` policy. The gateway builds a separate client for that host and pins the validated addresses into reqwest. The request URL keeps the provider hostname, so rustls still applies its standard CA and hostname checks. Each pinned client expires after five minutes. The next request resolves and validates a fresh address set before replacing it.

A shared semaphore allows eight provider requests at once. A request may wait up to ten seconds for a permit. Each HTTP attempt has ten second connect, read, and total time limits. OMDb and TMDB retry GET responses twice for HTTP 429 and server errors. Responses are read in chunks and rejected above 2 MiB, or 4 MiB for AniList. AniList request bodies are capped at 256 KiB. Query URLs are capped at 32 KiB.

`test_metadata_keys(&keys, offline_mode)` implements the existing tests for TMDB, OMDb, Fanart.tv, OpenSubtitles, and TheTVDB. It returns `Vec<MetadataKeyTestResult>` in the current `{ provider, ok, message }` shape. Unknown providers return a failed result with the existing unsupported-provider message. The Tauri handler should authorize settings writes before invoking this method, matching the Electron handler. Pass the current offline setting if key tests must respect offline mode.

Provider responses remain untyped because the React callers already validate the returned JSON. Gateway errors use fixed messages or HTTP status numbers. They never include request URLs, response URLs, API keys, bearer tokens, or provider response bodies.

Electron resolves and pins a provider address for each request. The Rust gateway pins the complete validated address set for up to five minutes. Both designs close the second-lookup and keepalive rebinding paths. Rust may use an address after its DNS record changes, but it re-resolves within five minutes without requiring an app restart.

No network calls, app launches, or runtime checks were performed while adding this module.
