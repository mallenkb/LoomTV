# LAN discovery in the Tauri desktop

The Rust desktop client browses `_loomtv._tcp.local.` for a bounded period. It does not publish a service. `discover(timeout_ms)` clamps the scan to 500 through 30,000 milliseconds and returns the existing `LocalNetworkPeer[]` JSON shape.

Protocol-v2 records must have exactly these four TXT properties: `protocolVersion`, `instanceId`, `port`, and `certFingerprint`. The parser requires protocol version `2`, a canonical decimal port that matches the SRV port, and a 64 digit hexadecimal SHA-256 certificate fingerprint. Device IDs must contain 8 through 128 ASCII bytes, start with a letter or digit, and contain only letters, digits, hyphens, underscores, periods, or colons. The parser also checks the DNS-SD instance name and `.local.` hostname. Unknown or malformed records do not appear in the result.

The current React desktop code puts `peer.host` into an unbracketed HTTPS URL. The Rust client returns valid unicast IPv4 addresses only. It rejects unspecified, loopback, multicast, and broadcast addresses. Supporting IPv6 requires the React URL construction to bracket IPv6 literals first.

Resolved records are deduplicated by device ID. Matching records merge their addresses. If one device ID resolves with conflicting names, ports, or certificate fingerprints during the same scan, the client drops that ID. Results sort by device name and then device ID.

Add this dependency to `crates/loomtv-core/Cargo.toml`:

```toml
mdns-sd = { version = "0.21.2", default-features = false, features = ["async"] }
```

The `async` feature supplies `Receiver::recv_async`. The module does not need the crate's logging or Serde features.

Expose the module from `crates/loomtv-core/src/lib.rs` with `pub mod discovery;`. The Tauri `network:discover-peers` handler can parse its optional timeout, default it to 2,500 milliseconds, and call `loomtv_core::discovery::discover(timeout_ms).await`. The handler should pass the returned error through the bridge. Converting an mDNS setup or socket failure into `[]` would make an unavailable network look like a successful scan with no peers.

The scanner stops the browse and requests daemon shutdown on every exit path. A scan with no daemon error returns `[]` when the deadline expires. Multicast filtering that the operating system does not report is indistinguishable from a network with no LoomTV hosts.
