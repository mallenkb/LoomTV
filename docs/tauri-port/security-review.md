# Tauri security review

Updated 2026-09-07. This is a targeted review of the changed local media and content-rating paths, not a completed threat model or whole-product security approval. The full specification's security gate remains open.

## Corrected rating authorization defect

Reference: `apps/desktop/src/main/metadata/contentRatings.ts` at `7ab2267d776c05c39bc09134295dfcb48baa0069`.

The Rust provider normalizers omitted many known non-US age mappings and returned age zero when numeric inference failed. For example, an Australian `M` or Canadian `R` code could receive a zero age and pass a child-profile age check. Both metadata refresh and official-artwork metadata paths had their own version of the normalizer.

`ad20b003a2dd6aea1b7b96e5db0fcae628b3e38a` replaces those copies with one `content_ratings` module. Its checked-in fixture contains all 92 known country/code mappings from the referenced Electron source. Known values preserve the reference ages and byte-normalization behavior. Unknown nonnumeric values remain unrated, so the profile's `allowUnrated` rule applies instead of treating them as suitable for every age. The Electron reference also falls back to zero for unknown codes; that unsafe fallback was deliberately not copied.

Stored records are rechecked when authorizing content. The effective minimum age is no lower than either the recorded age or the normalized known age. This repairs the authorization effect of existing under-rated Rust rows without mutating user data. Unknown or malformed stored ratings remain unrated. This change does not perform a database migration or alter Electron's source.

Executed checks: all known fixture mappings, unknown-code rejection, source validation, missing fields, stale zero-age rows and preservation of stricter stored ages. These are unit checks of normalization/authorization helpers, not a full end-to-end child-profile test suite.

## Local playback boundaries checked

The generated-media integration test at `ad20b00` exercises real FFmpeg output through a loopback media server with temporary storage. It verifies suffix/partial/invalid ranges, HEAD behavior, invalid segment names, forged Host rejection, profile-lock revocation and removal of owned transcode output. Separate unit checks cover track-index validation, invalid options and segment-name traversal protection.

The implementation bounds sessions, encoder windows, restarts, active requests and cached output. Processes are terminated and reaped on session shutdown, and authorization is rechecked during streaming. The tests establish the declared local fixture behavior. They do not establish protection for every remote redirect, DNS change, media decoder, native callback, provider, add-on, image or subtitle input.

Evidence: run `34092078082`, job `101647508196`, artifact `10007229673`. The exact verified patch was committed as `ad20b00`.

## Unresolved risks

| Area | Remaining work |
| --- | --- |
| Live shared storage | Startup still defaults to the Electron data directory. The prior shared-data request and the checklist's isolated-default requirement have not been reconciled. Concurrent writers, backup/restore and schema ownership are not verified. Use only an isolated `LOOMTV_DATA_DIR` for desktop evaluation. |
| Credential storage | The inherited settings path preserves Electron-compatible database fields. That does not establish OS-backed protection, a reviewed safeStorage transfer, keychain failure behavior or a safe migration. Do not use real secrets in parity tests. |
| Native playback | FFI lifetime/thread invariants, actual platform composition, TLS behavior at LibVLC, session recovery and driver behavior require native testing. macOS compilation is insufficient. |
| Remote and hosted services | Pairing, certificate rotation, redirects, revocation, account/device scopes, all compatibility routes and hosted administration require broader negative tests and feature closure. |
| Add-ons and untrusted media | Stremio execution/configuration, SSRF controls, malicious artwork/subtitle inputs and archive handling are not comprehensively verified. |
| Update and packaging trust | Signed updates, installer identity, clean installation and production artifact inspection remain open. No release was published. |

The remaining Tauri CI workflow has read-only permissions and does not use production secrets. Temporary source-transfer jobs used the repository's existing protected environment only for branch commits, with deployment creation disabled; they did not publish packages, installers, releases or tags. Those temporary workflows have been removed.
