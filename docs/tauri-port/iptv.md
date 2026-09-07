# IPTV service

`crates/loomtv-core/src/iptv.rs` implements the six desktop IPTV commands against the existing schema 14 tables. It retains stored source IDs and channel IDs. It does not open, copy, or migrate an Electron database.

Create one `IptvService` with the shared `Arc<tokio::sync::Mutex<Store>>` already held by the Tauri runtime. Its command methods are `list_sources`, `add_source`, `update_source`, `remove_source`, `refresh_source`, and `list_channels`. `channel_stream_url` resolves the stored HTTPS stream for playback without accepting an upstream URL from the renderer.

Source and channel reads require an active profile. Adding, updating, removing, and refreshing a source require the owner profile. Add attempts keep a new source when its first refresh fails, including the saved refresh error, so the user can correct it or retry. Repeated refresh calls for one source share a single background job.

Playlist and guide downloads accept HTTPS only. They reject URL credentials, private and reserved addresses, mixed public and private DNS results, oversized responses, and unsafe redirect targets. Each connection pins the validated address set while rustls applies normal CA and hostname checks. Downloads use a four-request gate, a 45 second request timeout, a 120 second operation timeout, one retry for HTTP 429 and server errors, two redirects, a 24 MiB playlist cap, and a 64 MiB guide cap. Gzip output has the same 64 MiB guide limit.

The M3U parser is implemented in the module and needs no playlist parsing crate. It accepts up to 20,000 unique HTTPS channels, retains the provider's normal `tvg-id` channel identity, creates stable URL identities when that field is absent, counts malformed, duplicate, and plain HTTP entries, and keeps the advertised HTTPS guide URL. The XMLTV scanner retains up to 200,000 programmes for channel IDs present in the playlist.

Channel queries retain the current 200-row page cap, one million row offset cap, group and subcategory filters, geo filters, category and descending-name sorts, eight-term accent-folded search, and current and next programme fields. Search terms remain SQL parameters and escape wildcard characters.

The module needs these direct `loomtv-core` dependencies:

- `flate2 = "1"` for bounded gzip guide decoding.
- `chrono = "0.4"` for XMLTV local and fixed-offset timestamps.
- `unicode-normalization = "0.1"` for the existing accent-folded search behavior.

No M3U parsing dependency is required. No tests, app launches, playlist requests, database access, or credential access were performed while adding this module.
