# Desktop catalog projections

`crates/loomtv-core/src/catalog.rs` reads the shared version 14 Electron database without changing its schema. `library:get` returns full media records, `library:get-index` returns compact cards, and `library:get-item` returns one full media record with the catalog envelope.

Full records include the stored provider ratings, country ratings, streaming providers, origin platform, artwork candidates, cast, local media details, provider IDs, seasons, episode metadata, episode files, subtitles, and local playback paths. Compact cards omit cast, subtitles, provider IDs, episode bodies, and local metadata. Their `playbackReferences` retain the local progress keys and episode identity used by the desktop renderer.

All three projections keep the existing active-profile requirement. Library lists call `Store::can_access_item` before building each item. A direct item request returns the existing `content_restricted` error when the active profile cannot access that media.

Items under a configured `others` root remain in the `others` collection. TV and anime membership checks episode-file paths before falling back to the aggregate item path.

Artwork delivery has two supported forms. Durable, non-loopback HTTPS URLs pass through to the renderer. A `loomtv-custom-artwork://artwork/<media-id>/<target>` reference becomes a profile-scoped `loomtv://localhost/api/custom-artwork` URL with decoded `mediaId` and `target` query values plus the active profile ID and selection revision. The Tauri protocol handler must authorize that media ID through the active profile, check the revision, read only the matching `custom_artwork` row, enforce a response-size limit, and allow the stored image MIME types.

Inline data artwork, stale loopback URLs, plain filesystem artwork paths, and other URL schemes are omitted. Supporting cached provider images or arbitrary local image files later requires another scoped host-owned protocol route. The catalog does not expose those paths through an artwork field.
