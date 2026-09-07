# Stremio add-on state

`crates/loomtv-core/src/stremio_store.rs` implements the storage-only part of the desktop Stremio contract. `Store::invoke_stremio_store(channel, args)` returns Electron’s `{ ok, data }` or `{ ok, error }` envelope and supports these channels:

- `plugins:stremio:list`
- `plugins:stremio:available`
- `plugins:stremio:official`
- `plugins:stremio:review-installed`
- `plugins:stremio:disable`
- `plugins:stremio:remove`
- `plugins:stremio:profile-access`
- `plugins:stremio:set-profile-access`
- `plugins:stremio:configuration`
- `plugins:stremio:save-configuration`
- `plugins:stremio:audit`

Managed state, installed review snapshots, profile access, configuration presence, and audit history use the existing schema 14 rows. The official list contains the same Cinemeta and OpenSubtitles v3 entries as Electron. Owner access is required for management reads and writes. Available add-ons use the active profile: Owner receives every enabled and requestable add-on, Standard receives explicit grants, and Guest and Kids receive none.

Reviewing an installed add-on requires Electron’s fresh protected manifest request and review-token rotation. The storage module verifies that the add-on exists, then returns `STREMIO_PLUGIN_PROVIDER_GATEWAY_REQUIRED`; it does not present a stored snapshot as a completed review. Online manifest review remains part of the provider gateway.

Electron stores each current add-on as a public version 2 JSON envelope. Its manifest endpoint is a protected secret reference, and `integrity_mac` is signed with a key encrypted by Electron `safeStorage`. The Rust module validates envelope size, identity, lifecycle and trust consistency, manifest structure, protected-reference presence, public URL metadata, and MAC shape. It cannot verify the MAC or recover the protected manifest endpoint until a compatible codec is available. No network-capable Stremio operation may rely on these records before that verification is added.

Configuration reads expose declared fields, host secret-reference presence, and the shared secret-store revision. They never read ciphertext. Add-ons that need configuration remain conservatively `configured: false` because reference presence does not prove that encrypted values are valid and nonempty. Add-ons that need no host configuration remain `configured: true`. Configuration writes return `STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED` without changing secrets.

Removing an add-on deletes its state, profile grants, and protected configuration rows in one transaction, advances the global state revision, and records `addon_removed`. The existing artwork cleanup remains a caller responsibility, as it is in Electron’s main-process composition. Profile access mutations preserve the Owner, Standard, Guest, and Kids rules.

Disabling requires a signed rewrite of the stored install record. Legacy unsigned records can be disabled transactionally. Current Electron-protected records return `STREMIO_PLUGIN_CREDENTIAL_CODEC_REQUIRED` and remain unchanged, avoiding an invalid MAC or a state row that Electron would reject. Existing profile grants can be removed safely. Creating a grant from an Electron-protected record also requires compatible HMAC verification and returns the same error until that codec is available.

Manifest URL review, official review, approval, catalog, metadata, streams, subtitle delivery, provider health, and compatible secret encryption and integrity verification remain gateway work.

No tests, network requests, application launches, user database reads, or credential access were performed while adding this module.
