# LoomTV plugin protocol foundation

This document describes the declaration-only plugin protocol introduced in
`@loom-media-server/plugin-protocol`. It is a foundation for future external
providers, not a plugin runtime or catalog.

The protocol is intentionally LoomTV-native: a manifest declares what a
provider may participate in, while LoomTV keeps ownership of the media
library, profiles, devices, stream authorization, and playback decision.

## Manifest v1

The canonical schema is
[`packages/plugin-protocol/schema/plugin-manifest.v1.schema.json`](../packages/plugin-protocol/schema/plugin-manifest.v1.schema.json).
The small safe example is
[`packages/plugin-protocol/examples/metadata-catalog.manifest.json`](../packages/plugin-protocol/examples/metadata-catalog.manifest.json).

```json
{
  "manifestVersion": 1,
  "id": "org.example.loom.metadata",
  "name": "Example catalog metadata provider",
  "version": "0.1.0",
  "loomApi": { "range": ">=1.0.0 <2.0.0" },
  "capabilities": [
    { "type": "metadata.catalog", "apiVersion": 1 }
  ]
}
```

Required fields are:

- `manifestVersion`: the manifest schema version. v1 is `1`.
- `id`: a lowercase reverse-DNS identity, for example `org.example.loom.metadata`.
- `name`: short human-readable name.
- `version`: plugin release SemVer.
- `loomApi.range`: the stable SemVer range of Loom API versions the plugin supports.
- `capabilities`: one or more explicitly supported capability declarations.

Optional metadata is limited to `description`, `author`, and an HTTPS
`homepage`. Unknown fields are rejected, so adding an entrypoint, permissions,
transport URL, or runtime escape hatch cannot silently expand the protocol.

The v1 range grammar supports exact stable SemVer, whitespace-separated
comparators (`>=1.0.0 <2.0.0`), caret, tilde, and x-ranges. OR ranges and
prerelease API ranges are rejected at the runtime boundary. The current host
API constant is `1.0.0` and is independent of the LoomTV app release number.

## Capability allowlist

Only these categories are supported in v1:

| Capability | Declaration | Host-mediated boundary |
| --- | --- | --- |
| Metadata/catalog provider | `metadata.catalog` | May contribute catalog metadata candidates. LoomTV normalizes and chooses what enters its library. |
| Subtitle provider | `subtitle.provider` | May contribute subtitle candidates. LoomTV chooses, downloads, caches, and applies subtitles through its existing policy. |
| Playback provider | `playback.provider` with `hooks` | May return source candidates or variants through an approved hook. LoomTV still owns authorization, signed stream issuance, direct-play/transcode choice, and delivery. |

Playback hooks are currently limited to:

- `resolve-source`: resolve a request into a candidate source descriptor.
- `list-variants`: list candidate playback variants for LoomTV to evaluate.

These hooks are declarations only in this foundation. A future implementation
must define request/response contracts, timeouts, origin and transport policy,
and a reviewed isolation boundary before invoking external provider code.

## Install and load validation

Both trust boundaries must use the shared validator. The functions intentionally
have separate names so a future installer and loader cannot accidentally skip
validation when wiring persistence:

```js
import {
  LOOM_PLUGIN_API_VERSION,
  installPluginManifest,
  loadPluginManifest,
} from '@loom-media-server/plugin-protocol';

// Parse JSON before this call; the result is validated and deeply frozen.
const installedManifest = installPluginManifest(untrustedJson, {
  loomApiVersion: LOOM_PLUGIN_API_VERSION,
});

// Validate the persisted declaration again before exposing it to a runtime.
const loadedManifest = loadPluginManifest(persistedJson, {
  loomApiVersion: LOOM_PLUGIN_API_VERSION,
});
```

`validatePluginManifest` rejects unknown capability categories, unknown fields,
unsupported capability API versions, duplicate categories/hooks, malformed
identities or versions, incompatible Loom API ranges, non-HTTPS homepages, and
all undeclared capabilities. It does not fetch a homepage or execute anything.
Failures are reported as `PluginManifestValidationError` with path-aware
`issues`.

## Security boundary

The manifest cannot grant:

- raw local filesystem access;
- arbitrary local network access;
- unrestricted Node.js or Electron APIs;
- profile, device, session, or credential access;
- a bypass around signed-stream authorization;
- authority over media sharing, direct play, remux, or transcode selection.

There is no arbitrary third-party code execution in this change. No secure
sandbox is currently part of the protocol package, so provider execution and
plugin installation UI are intentionally left for a separate security-reviewed
implementation. Until then, this package is safe to use for schema discovery,
manifest persistence, compatibility checks, and capability negotiation only.
