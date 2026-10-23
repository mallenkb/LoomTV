# Desktop dependency license texts

The package folders contain unmodified license and notice files copied from
the installed direct desktop runtime dependencies on 23 October 2026.
`inventory.json` records their package versions and paths. The installed
versions matched `apps/desktop/package.json`; Zod uses the workspace catalog.

Both desktop packaging configurations include this directory, the root
`LICENSE`, and `THIRD_PARTY_NOTICES.md`. Recheck the actual packaged artifacts
before release. Packaging was not run for this attribution update.

When a dependency changes, refresh its license and notice texts from that
exact version and update the inventory. Preserve the full upstream text.
These snapshots cover direct dependencies only. Transitive dependencies,
Electron/Chromium notices, native libraries, and any copied source require
their own release inventory and applicable notices.

`stremio-official-addons.LICENSE.md` is the registry's upstream MIT license.
Its source URL is recorded in the inventory. It does not license the hosted
services, subtitles, metadata, artwork, or provider trademarks.

## Outstanding publication evidence

- Add TMDB's approved logo from its official attribution page. The required
  disclaimer is in About, but the official SVG endpoint returned HTTP 403
  during this update; no replacement logo was fabricated.
- Verify the permissions and display rules for the rating brands and SVGs.
- Supply and verify corresponding native-runtime source, build information,
  license texts, and the appropriate combined-distribution terms.
- Verify full transitive dependency notices against the final release.

This inventory records attribution work, not legal clearance or proof of
independent authorship of all application code.
