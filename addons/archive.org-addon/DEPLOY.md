# Archive.org addon — deploy notes

Base URL: `https://dev.nebulawp.org/stremio/archive.org-addon/`

## What was wrong

1. `manifest.json` declared `"resources": ["stream"]` with `"catalogs": []`.
   Stremio apps therefore show no browsable catalog, and LoomTV's
   `ArchiveOrgAddon` page has nothing to back its listing.
2. `/stream/movie/<tt-id>.json` answered **every** `tt*` id with a guessed
   Archive.org file (e.g. `tt0068646` Godfather and `tt0111161` Shawshank —
   both copyrighted — returned streams, and `tt9999999` returned a random
   YouTube rip). The lookup was a free-text search, not a verified mapping,
   so the "public domain movies only" claim did not hold.

## The fix (this directory)

- `manifest.json` (v10.1.0): declares `catalog` + `meta` + `stream`,
  one catalog `movie/archive-pd` ("Public Domain Movies") with
  `search` and `skip` extras, `behaviorHints.p2p: false`.
- `index.php`: fixed allowlist of 18 IMDb ids, each pinned to an
  Archive.org identifier whose `licenseurl` was verified to contain a
  public-domain mark. Stream requests re-verify the license live
  (1h cache) and return `{"streams": []}` for anything not on the list.
- `.htaccess`: serves `manifest.json` statically, routes
  `catalog/`, `meta/`, `stream/` to `index.php`, adds CORS headers.

## Deploy (cPanel / LiteSpeed shared hosting)

1. Open cPanel File Manager → `public_html/stremio/archive.org-addon/`.
2. Upload `manifest.json`, `index.php`, `.htaccess` (overwrite).
   Keep the existing `stremioAddonsConfig` signature out — LoomTV ignores
   it and it becomes stale after the manifest changes.
3. Verify:
   - `…/manifest.json` → version `10.1.0`, non-empty `catalogs`
   - `…/catalog/movie/archive-pd.json` → 18 `metas`
   - `…/meta/movie/tt0063350.json` → Night of the Living Dead meta
   - `…/stream/movie/tt0063350.json` → 1 stream (archive.org download URL)
   - `…/stream/movie/tt0068646.json` → `{"streams":[]}` (copyrighted, correctly empty)
   - `…/stream/movie/tt9999999.json` → `{"streams":[]}`

## Local check

```sh
php -l addons/archive.org-addon/index.php
php -S 127.0.0.1:8777 -t addons/archive.org-addon
curl -s http://127.0.0.1:8777/manifest.json | head -c 400
curl -s http://127.0.0.1:8777/stream/movie/tt9999999.json
```
