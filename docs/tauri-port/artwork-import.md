# Legacy artwork import

`crates/loomtv-core/src/artwork_import.rs` implements the existing `artwork:import` contract used by `migrateLegacyArtwork`. The single argument has this shape:

```text
{
  mediaId: {
    target: dataUrl
  }
}
```

The method requires an unlocked owner profile, validates the complete nested object before writing, skips empty artwork strings, and inserts every remaining row in one SQLite transaction. A malformed row rolls back the entire import. The method returns `true`, including when the map is empty or contains only empty artwork strings.

The migration keeps Electron's repository behavior by storing each nonempty string as supplied. It does not require the media item to exist and does not reinterpret the target or artwork value. This matters during startup migration because legacy local storage may be imported before the current library view is rebuilt. The existing custom artwork resource path still validates image data before serving it.

The core method also caps the serialized entries object at 2 MiB and the nested map at 10,000 rows. The Tauri invoke boundary already has the same byte limit, while the row limit keeps direct core callers bounded.

Expose the module from `loomtv-core` with `mod artwork_import;`. Route `artwork:import` to `Store::import_custom_artwork(&args)`. The TypeScript IPC contract and bridge already expose this channel and need no changes.
