# Official artwork workflow

The Rust core implements the three Electron artwork operations in `official_artwork.rs`:

- `official_candidates` returns the `artwork:official-candidates` candidate array.
- `apply_official` applies `all`, `poster`, `cover`, `logo`, `summary`, or `episodes` and returns the stored artwork result.
- `refresh_official` refreshes `all`, `poster`, `cover`, or `logo` and returns the same target-specific result shapes as Electron.

Each operation requires an unlocked Owner profile. The caller supplies the active profile ID and selection revision. The module checks both before and after every provider request and again before the database transaction. Cancellation uses the shared `AtomicBool` and prevents later provider requests or a commit.

`apply_official` does not trust metadata returned by the renderer. It fetches the current candidate list and applies the matching candidate ID. A suffixed poster, cover, or logo selection is accepted only when the selected HTTPS URL still appears in that candidate's target-specific artwork list.

The transaction updates only provider metadata, the requested artwork fields, season metadata, episode metadata, and refresh locks. Media IDs, file paths, episode file rows, local episode metadata, playback progress, and custom artwork rows remain intact. Applying official artwork replaces the selected target's primary reference, including a `loomtv-custom-artwork:` reference. Other artwork targets keep their current values. Category locks match Electron: `all` locks `core`, `cast`, `artwork`, `ratings`, and `episodes`; `summary` locks `core`; `episodes` locks `episodes`; individual artwork targets lock `artwork`.

The provider gateway currently supports TMDB, OMDb, and AniList. Candidate search and refresh use configured TMDB and OMDb keys, plus AniList for anime. TVmaze, TVDB, Jikan, and Fanart.tv remain absent because the gateway cannot issue those production requests yet. The module does not claim candidates or refresh data from those providers. TMDB supplies episode metadata for local season and episode identities. OMDb supplies its rating block. AniList supplies anime identity, core fields, artwork, and cast.

Provider work is bounded to five results per keyed provider, 24 returned candidates, 15 local seasons, 5,000 local episodes, 32 images per artwork target, and 20 cast records. The module never holds the database mutex during provider requests.

The module does not cache downloaded artwork. It stores provider HTTPS URLs and leaves image fetching to the existing artwork delivery path. No runtime, provider, or real database verification was performed. `cargo check -p loomtv-core` passed after the module declaration was added.
