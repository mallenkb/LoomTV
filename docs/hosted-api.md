# LoomTV hosted API

The canonical server exposes the same-origin client at `/app/`, server control at `/admin/`, and the versioned JSON API at `/api/v1`. Versioned responses carry `X-LoomTV-API-Version: 1`.

Public discovery resources:

```sh
curl https://loomtv.example/api/v1/discovery
curl https://loomtv.example/api/v1/openapi.json
```

## First owner and sign-in

Server startup prints or otherwise supplies a one-time bootstrap secret. Owner creation requires that secret and invalidates it atomically:

```sh
curl -sS -X POST https://loomtv.example/api/v1/auth/owner \
  -H 'content-type: application/json' \
  -d '{"name":"Owner","password":"change-this-password","bootstrapSecret":"one-time-secret"}'
```

`POST /api/v1/auth/session` creates either a bearer session or a same-origin secure cookie session. The hosted browser chooses cookies on HTTPS and holds cleartext-development bearers only in memory. Device, pairing, invitation, download, playback, and cast capabilities use separate schemes and scopes.

## Canonical resources

The API includes:

- accounts, users, passwords, devices, pairing, sessions, remote policy, and audit events;
- library roots, scans, catalog items, series, seasons, and episodes;
- profiles, PINs, selection, restrictions, preferences, lists, track preferences, and progress;
- playback planning, direct capabilities, HLS start/renew/stop, and external subtitle capabilities;
- private invitations and invitation sessions;
- offline download leases and ranged content;
- cast session create/update/renew/stop;
- health, diagnostics, logs, backups, and restore.

Successful JSON resources use `{ "ok": true, "data": ... }`. Errors use `{ "ok": false, "error": { "code", "message" } }`. Discovery and OpenAPI documents are top-level documents.

## Playback

Clients never receive a permanent media URL from `GET /api/v1/media/<mediaId>`. They post their codec, container, resolution, HDR, HLS, and subtitle capabilities to the returned `playbackPlanUrl`.

The plan returns one of these bounded paths:

- a short-lived direct capability and renewal route;
- an HLS start route that returns an expiring playlist session and renewal route;
- an external text-subtitle capability when the client can render it;
- a burn-in plan when the selected subtitle cannot be rendered safely by the client.

Capabilities bind the authenticated principal, device, selected profile and revision, media source identity, and requested action. Revocation, profile changes, source changes, session expiry, or remote-policy changes invalidate the relevant path.

## Downloads

`POST /api/v1/downloads` reserves quota and returns a persistent `LoomDownload` capability. The secret belongs in the `Authorization` header for `/api/v1/downloads/<id>/content`, not in a URL. A client can list and revoke its leases. The server rechecks permissions, invitation scope, profile selection, root, source identity, size, expiry, and range policy before every read.

## Private sharing

An account with `sharing.manage` can create an expiring invitation scoped to one profile, selected roots, optional media IDs, permissions, and download quota. The creation response shows its secret once. Acceptance exchanges `LoomInvite` for a revocable `LoomInvitation` session. Revoking the invitation also invalidates its sessions and download authority.

## Remote access

Same-LAN use is the default. For remote access, terminate HTTPS at an explicitly trusted reverse proxy, configure the proxy allowlist, and enable the remote policy only for the required accounts and devices. The server derives the client address and secure-transport state only through that allowlist. LoomTV does not emit wildcard CORS headers, automate router exposure, or provide a hosted relay.

## Compatibility

Version 1 is additive within existing resources. Clients must ignore unknown response fields and gate optional behavior through discovery. A new major path such as `/api/v2` represents a breaking contract. Legacy v2 routes are compatibility adapters over canonical services and must not open independent persistence.

Public catalog, root, playback, download, subtitle, diagnostics, and migration report payloads do not expose raw host filesystem paths or credential material.
