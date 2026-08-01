# LoomTV hosted API

The headless server exposes a stable, same-origin browser client at
`/app/` and a versioned JSON API at `/api/v1`. Every versioned response carries
`X-LoomTV-API-Version: 1`. Discovery and machine-readable route metadata are
available without signing in:

```sh
curl http://127.0.0.1:3847/api/v1/discovery
curl http://127.0.0.1:3847/api/v1/openapi.json
```

## First-run and sign-in

Check onboarding, create the first owner, or create a session:

```sh
curl -s http://127.0.0.1:3847/api/v1/auth/onboarding
curl -sS -X POST http://127.0.0.1:3847/api/v1/auth/owner \
  -H 'content-type: application/json' \
  -d '{"name":"Owner","password":"change-this-password"}'

curl -sS -X POST http://127.0.0.1:3847/api/v1/auth/session \
  -H 'content-type: application/json' \
  -d '{"username":"Owner","password":"change-this-password"}'
```

The response contains an `adminToken`. Keep it in memory for a browser client
when possible; use `Authorization: Bearer <adminToken>` for JSON requests. The
existing `/api/admin` contract remains available for control-plane clients.

## Library, profiles, and progress

```sh
TOKEN='paste-token-here'
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3847/api/v1/library
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3847/api/v1/library/roots
curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:3847/api/v1/library/scan

curl -H "Authorization: Bearer $TOKEN" -X POST \
  -H 'content-type: application/json' \
  -d '{"name":"Living room","type":"standard"}' \
  http://127.0.0.1:3847/api/v1/profiles

curl -H "Authorization: Bearer $TOKEN" -X PUT \
  -H 'content-type: application/json' \
  -d '{"position":612,"duration":3600}' \
  http://127.0.0.1:3847/api/v1/profiles/<profileId>/progress/<mediaId>

Administrators can use the same versioned surface for scoped user accounts,
library-root management, diagnostics, password changes, sessions, logs, and
backup/restore. These routes use the same permission names as `/api/admin`.
```

Profiles and progress are stored in the headless data directory and are scoped
to the authenticated account. The owner can inspect all profile records; other
accounts can only access profiles they created.

## Playback

`GET /api/v1/media/<mediaId>` returns the item plus tokenized `directUrl`,
`downloadUrl`, and `transcodeUrl`. Direct browser playback uses a five-minute,
media-and-user-bound query token because an HTML `<video>` element cannot
attach an Authorization header:

```js
const details = await api(`/api/v1/media/${mediaId}`);
video.src = details.directUrl;
```

For incompatible media, `POST` the returned `transcodeUrl` with the bearer
token and requested `codec`, `maxWidth`, `maxHeight`, or bitrate query values.
The response contains an HLS playlist URL whose session token is validated by
the server for up to 30 minutes. Hardware selection and software fallback remain host-specific and
are reported through `/api/v1/discovery`. `/app/` probes direct playback first
and uses the packaged HLS runtime for browsers without native HLS support.

Successful JSON resources use an `{ "ok": true, "data": ... }` envelope;
discovery and OpenAPI documents are intentionally top-level documents. Error
responses use `{ "ok": false, "error": { "code", "message" } }`. Catalog and
root responses omit host filesystem paths; mounted media remains server-owned.

## Operations and compatibility

The same versioned surface exposes safe health and scoped operational resources:

```sh
curl http://127.0.0.1:3847/api/v1/health
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:3847/api/v1/logs?level=warn&limit=50'
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3847/api/v1/backups
```

Backup creation and restore require `backup.create`; logs require `logs.read`.
Restore validates the checksum and writes a pre-restore rollback snapshot before
replacing state. The media API remains read-only unless an account is granted
the separate `media.delete` permission. Public API backup writes and restores
are restricted to the server-owned backup directory; use the admin API for
deployment-local backup workflows that intentionally target another mounted
volume.

Version `1` is additive within its resource names. Clients should ignore
unknown response fields, use the discovery document to gate optional
capabilities, and treat a changed major path (`/api/v2`) as a new contract.
The server sends `X-LoomTV-API-Version: 1` on every versioned response. Webhook
subscriptions are intentionally not part of this contract yet; they remain a
separate notifications feature so clients do not depend on an unstable event
delivery model. The hosted client is same-origin by design; the server does
not emit wildcard CORS headers. Cross-origin browser integrations should use a
trusted reverse proxy that adds an explicit origin allow-list.

Media files stay read-only from LoomTV's perspective. The API never exposes
host filesystem paths to normal client responses.
