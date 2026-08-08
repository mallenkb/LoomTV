# LoomTV headless server

`loomtv-server` is the headless runtime boundary for LoomTV. It starts without
Electron, a display server, or a tray process and is suitable for a
NAS/container deployment. Library scanning, catalog access, direct media
delivery, HLS transcoding, a hosted browser client, and browser administration
are available without a desktop session.

## Shared runtime core

Electron and the headless service both consume
`@loom-media-server/media-core`. The package owns stable media IDs, the video
extension vocabulary, playback-profile normalization, and portable profile
identity. Database persistence and hardware backend selection stay behind each
runtime's adapter for now, but callers no longer need separate identity or
playback-profile algorithms.

## Start

From the workspace:

```sh
pnpm --filter loom-media-server-headless start
```

Or invoke the entry point directly:

```sh
node apps/server/src/cli.js --host 0.0.0.0 --port 3847 \
  --data-dir /var/lib/loomtv --cache-dir /var/cache/loomtv --media-dir /media
```

The command creates the data and cache directories. A configured media root is
not created: a missing or disconnected NAS share is reported as `offline` in
health so it cannot be mistaken for an empty library.

## Configuration

CLI flags take precedence over environment variables. Both the short names,
which are convenient for containers, and the `LOOMTV_*` aliases are supported:

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Bind address | `--host` | `HOST`, `LOOMTV_HOST` | `127.0.0.1` |
| HTTP port | `--port` | `PORT`, `LOOMTV_PORT` | `3847` |
| Persistent data | `--data-dir` | `DATA_DIR`, `LOOMTV_DATA_DIR` | platform app-data/LoomTV |
| Cache | `--cache-dir` | `CACHE_DIR`, `LOOMTV_CACHE_DIR` | `<data-dir>/cache` |
| Media root | `--media-dir` | `MEDIA_DIR`, `LOOMTV_MEDIA_DIR` | not configured |
| Require secure requests | `--require-secure-transport` | `REQUIRE_SECURE_TRANSPORT`, `LOOMTV_REQUIRE_SECURE_TRANSPORT` | `false` |
| Trusted proxy allowlist | `--trusted-proxies` | `TRUSTED_PROXIES`, `LOOMTV_TRUSTED_PROXIES` | empty |

## Health contract

All of the following return the same JSON payload and `200` status when the
process is listening:

```text
GET /healthz
GET /api/health
GET /api/ping
```

The payload includes `contractVersion`, `mediaCoreContractVersion`, bound
address/port, resolved data and cache paths, and a media state of `online`,
`offline`, `permission-denied`, `not-directory`, or `unconfigured`. It also
reports the active headless media, scanning, and transcoding capabilities.

## Browser administration

Open `/admin/` from a browser on the trusted LAN. The no-build control surface
supports owner onboarding, short-lived account sessions, mounted-root health,
scan status, operational logs, headless-state backup, and scoped user accounts.
The owner can create viewer, user, or administrator accounts and assign a
specific set of permissions and library-root access. A viewer can read and
stream, a user can also transcode, and an administrator can manage the server.

The account API is available under `/api/admin`:

```text
GET    /users                         List user accounts (users.read)
POST   /users                         Create an account (users.manage)
PATCH  /users/:id                     Update role, permissions, roots, devices, limits, or disabled state
DELETE /users/:id                     Revoke and remove an account
POST   /account/password               Change the current password or reset another user
DELETE /session                        Revoke the current token
```

User creation accepts `name`, `password`, `role` (`viewer`, `user`, or
`admin`), optional `permissions` and `rootIds` arrays, an optional `deviceIds`
allow-list, and an optional `maxSessions` limit. Library and streaming routes
enforce both the account permission and assigned root scope; a user cannot
access media from another root. `GET /api/media/items/:id/download` requires
`downloads`, and `DELETE /api/media/items/:id` requires `media.delete`.
The `remote.access` permission is available for clients and reverse-proxy
policy, but the server cannot infer Internet-vs-LAN topology without a trusted
deployment signal.

The headless catalog is currently a persistence adapter rather than a direct
SQLite mount of the desktop database. Shared media IDs and playback-profile
normalization keep the two runtimes portable while the database extraction is
staged.

Sign-in attempts keep a short per-account lockout. Repeated failures from a
shared address use a bounded progressive delay instead, so one client cannot
hard-lock every account behind the same NAT or reverse proxy.

Forwarded addresses and transport are ignored by default. When LoomTV is behind
a TLS reverse proxy, set `--require-secure-transport` and list only the immediate
proxy peers, for example `--trusted-proxies 127.0.0.1/32,::1/128` for a proxy on
the same host. The equivalent environment value is
`TRUSTED_PROXIES=127.0.0.1/32,::1/128`. IPv4, IPv6, and CIDR entries are accepted;
malformed entries fail startup. LoomTV walks `X-Forwarded-For` from the trusted
immediate peer toward the client and stops at the first untrusted hop. Never add
a client/LAN range merely because requests originate there: allowlisting a peer
authorizes that peer to supply forwarding headers.

The trusted proxy must replace `X-Forwarded-Proto` with one value (`https` for
secure client requests); LoomTV rejects missing, comma-separated, or malformed
transport values. This keeps a client-supplied header from becoming a trust
signal when proxies are chained or reconfigured.

The former boolean `--trust-proxy`/`TRUST_PROXY=true` mode is intentionally not
accepted because it did not identify which peer was trusted. The server adds
browser security headers and never stores or logs plaintext passwords or
tokens.

Do not expose this first headless boundary directly to the public Internet.
Use a VPN or a separately authenticated reverse proxy, and keep the owner
password and admin token on a trusted network.

## Hosted browser client and versioned API

Open `/app/` for the viewer-facing client. It supports first-run owner
onboarding, account sign-in, profile selection/creation, library browsing,
direct browser playback with an HLS/transcode fallback, and server-side watch
progress. `/admin/` remains the control-plane UI for roots, scans, users,
diagnostics, logs, and recovery operations.

Integrations should use `/api/v1` rather than the internal `/api/admin` and
`/api/media` routes. The public contract advertises its version in
`X-LoomTV-API-Version: 1` and exposes discovery plus an OpenAPI document:

```text
GET  /api/v1/discovery
GET  /api/v1/openapi.json
POST /api/v1/auth/session
GET  /api/v1/library
GET  /api/v1/profiles
PUT  /api/v1/profiles/:profileId/progress/:mediaId
GET  /api/v1/media/:mediaId
POST /api/v1/media/:mediaId/transcode
```

The versioned API uses bearer sessions, stable `{ ok, data }`/`{ ok: false,
error: { code, message } }` envelopes for JSON resources, and permission
scopes from the same policy as the admin API. Direct/download URLs carry
five-minute, media-and-user-bound tokens because an HTML video element cannot
attach a bearer header; clients should prefer the returned URLs and never
persist a token in a URL or log. Catalog and library-root responses
intentionally omit host filesystem paths; mounted media remains server-owned.

## Backup and restore

The admin UI and `/api/admin/backup` create a versioned JSON envelope containing
the catalog, roots, account policy, scan checkpoint, logs, and hosted-client
profiles/watch progress. The envelope includes a SHA-256 checksum and is
written atomically. `POST /api/admin/backup/restore` validates the format and
checksum, writes an automatic pre-restore rollback snapshot, replaces both
state stores, and revokes active sessions. Raw state files from the first
headless release are accepted as a one-time legacy restore format.

Authenticated admin health reports persistent-storage `available` and
`writable` separately. Its typed `state` distinguishes missing, non-directory,
permission-denied, read-only, write, cleanup, and timeout failures after a
bounded exclusive-create/write/fsync/close/remove probe. Storage paths remain
absent from the public health summary. Health also includes free space,
verified-backup readiness, transcoder details, and operational checks. Logs
support `level`, `source`, `search`, `before`, `after`, `limit`, and `offset`
filters and are retained for 30 days (up to 250 entries).
