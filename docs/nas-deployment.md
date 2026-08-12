# LoomTV headless and NAS deployment

This guide covers the supported appliance shape for the headless LoomTV server:
an always-on Linux process, a browser on the LAN as its control plane, and
media stored on a host-mounted disk, SMB share, or NFS share.

The container and systemd examples use the server entrypoint at
`apps/server/src/cli.js`. They expect the headless server to expose
`GET /healthz`, `/app/`, and `/admin/`, and to accept `HOST`, `PORT`,
`DATA_DIR`, `CACHE_DIR`, and `MEDIA_DIR`. The desktop Electron app remains a
separate client/runtime, while the hosted client keeps portable profiles and
watch progress on the server.

The headless server now owns a small persistent catalog, safe background scans,
direct HTTP media delivery, on-demand HLS transcoding, and a same-origin
browser client. The deployment shape is stable now, so NAS operators can
exercise process startup, storage paths, health checks, permissions, browser
playback, and graceful shutdown without an Electron session.

## Storage model

Keep LoomTV's application state on local storage and mount media separately:

| Path | Contents | Backup | Container mode |
| --- | --- | --- | --- |
| `/config` | Headless admin/catalog state, hosted profiles, and progress | Yes | Read/write |
| `/cache` | Artwork, thumbnails, temporary transcode/cache data | Optional | Read/write |
| `/media` | Movies, shows, anime, subtitles | Usually no; back up at the NAS layer | Read-only recommended |

LoomTV does not manage SMB/NFS usernames or passwords. Mount the share on the
host, then pass the resulting directory to LoomTV. This keeps credentials out
of application settings, backups, diagnostics, and mobile clients.

When `/media` is unavailable, do not remove the mount and recreate it with an
empty directory. The scanner is expected to preserve the existing catalog and
show the root as unavailable. Restore the mount, confirm it is readable by the
LoomTV UID/GID, and run a scan again.

## Docker Compose

Create directories owned by the account that will run the container. The
default UID/GID is `1000:1000`; NAS images commonly use a different pair. Both
values must be non-zero: the image build and runtime entrypoint reject a root
UID or GID instead of starting with elevated filesystem access.

```sh
mkdir -p /srv/loomtv/config /srv/loomtv/cache
sudo chown -R 1000:1000 /srv/loomtv/config /srv/loomtv/cache
```

Mount the NAS on the host first. Examples (adapt the server, export, and
options to your NAS):

```sh
# SMB/CIFS (credentials remain in the host's protected credentials file)
sudo mount -t cifs //nas.example/media /srv/loomtv/media \
  -o credentials=/etc/samba/loomtv.cred,ro,uid=1000,gid=1000,vers=3.1.1

# NFS
sudo mount -t nfs4 nas.example:/volume1/media /srv/loomtv/media -o ro
```

Copy `deploy/docker/compose.yaml` to a deployment directory, then create a
`.env` beside it:

```dotenv
PUID=1000
PGID=1000
LOOMTV_PORT=3847
LOOMTV_CONFIG_DIR=/srv/loomtv/config
LOOMTV_CACHE_DIR=/srv/loomtv/cache
LOOMTV_MEDIA_DIR=/srv/loomtv/media
TZ=UTC
```

The checked-in Compose file builds the current checkout and names the local
image `loomtv:1.0.111`. The version is deliberate: update it only when the
checkout and the intended LoomTV release agree. Start and inspect the service:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --follow loomtv
curl --fail http://127.0.0.1:3847/healthz
# Open the viewer client or control plane from a trusted browser:
# http://127.0.0.1:3847/app/
# http://127.0.0.1:3847/admin/
```

For a registry deployment, remove `build:` and replace `image:` with either an
explicit publisher release version or, preferably, the verified multi-platform
index digest returned by the registry. Resolve that digest from the exact
release first; never substitute `latest`, a shortened digest, or a digest copied
from an untrusted release note:

```sh
docker buildx imagetools inspect registry.example/owner/loomtv:1.0.111
# Then set image: to registry.example/owner/loomtv@sha256:<verified-64-hex-digest>
```

The placeholder above is documentation, not a usable digest. Do not publish
port 3847 directly to the public Internet; use a VPN or a carefully configured
reverse proxy after authentication and remote-access policy are in place.

### Permissions

The image runs as a non-root user. If the container exits with a `PUID/PGID`
or write error, inspect the host mounts:

```sh
stat -c '%u:%g %A %n' /srv/loomtv/config /srv/loomtv/cache /srv/loomtv/media
```

The config and cache directories must be writable by `PUID:PGID`; media only
needs read access. The container does not chown bind mounts because doing so
would be unsafe on NAS volumes.

## Building for NAS architectures

The Dockerfile pins the Docker Hub multi-platform index for the readable
`node:22-bookworm-slim` base. It also replaces live Debian mirrors with one
timestamped snapshot, so `ca-certificates`, FFmpeg, Tini, and their transitive
apt dependencies cannot change during an otherwise identical rebuild. The
snapshot uses signed Debian `InRelease` metadata; HTTP is intentional because
the slim base may not have a CA bundle until this apt transaction installs it.

The base and Debian packages support both common Linux targets:

```sh
LOOMTV_IMAGE=registry.example/owner/loomtv:1.0.111
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/docker/Dockerfile \
  -t "$LOOMTV_IMAGE" \
  --push .
docker buildx imagetools inspect "$LOOMTV_IMAGE"
```

On a NAS that cannot build images, build and push from a workstation, then
`docker compose pull` on the NAS. Pin a digest for repeatable upgrades.

### Base image and apt rebuild policy

Pinned packages do not receive fixes by themselves. Review the container inputs
at least monthly, before a production release when practical, and immediately
when a relevant critical or high-severity Node, Debian, FFmpeg, Tini, or CA
certificate advisory is published. In one focused change:

1. Resolve the current `node:22-bookworm-slim` multi-platform index from Docker
   Hub and confirm it still contains both `linux/amd64` and `linux/arm64`.
2. Choose a UTC Debian snapshot at or after that base image's publication and
   verify both the `debian` and `debian-security` snapshot `InRelease` files.
3. Update both pinned `FROM` references and both Debian snapshot URLs together,
   review the apt package delta, run `corepack pnpm run container:verify` and
   `corepack pnpm run container:policy:test`, then build both target platforms.
4. Publish a new LoomTV release image; resolve its registry digest and update
   production Compose deployments to that digest. Keep the previous digest for
   rollback.

Do not replace the literal pins with build arguments or live mirror URLs. If
either registry or snapshot metadata cannot be verified, postpone the rebuild
rather than guessing.

## Hardware transcoding (opt-in)

Software FFmpeg is the default and works without special host access. Hardware
acceleration must be configured on both the host and container and should not
be enabled until direct playback and a software-transcode fallback work.

For Intel or AMD VA-API on Linux, install the host's GPU/media drivers, check
that `/dev/dri/renderD128` exists, and add the device in Compose:

```yaml
services:
  loomtv:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "RENDER_GROUP_ID"
```

Replace `RENDER_GROUP_ID` with the host's numeric `render` group ID. Some
systems also require the `video` group. Do not use a broad privileged container
as a substitute for the correct device/group permissions.

For NVIDIA, install the NVIDIA Container Toolkit and add a Compose GPU device
reservation (the commented example is already in `deploy/docker/compose.yaml`):

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu, video]
```

After the device is mounted, inspect the actual capability report rather than
assuming that an FFmpeg build advertising an encoder can use it:

```sh
curl --fail http://127.0.0.1:3847/api/transcoder/capabilities | jq .
# Force one-frame encoder probes for every advertised backend/codec:
curl --fail -H "Authorization: Bearer $LOOMTV_ADMIN_TOKEN" \
  http://127.0.0.1:3847/api/transcoder/self-test | jq .
```

The report distinguishes compiled encoders from a one-frame device probe and
will recommend a backend only after that probe succeeds. Hardware device access
is intentionally not enabled by the default Compose file. The forced self-test
requires an admin bearer token because it starts fresh FFmpeg probes and can
consume GPU resources; the cached capabilities endpoint remains read-only.

### Headless media API

After creating an owner and signing in to `/admin/` or `/app/`, the server
exposes these authenticated routes:

- `GET /api/admin/library/items` — indexed media records, including whether a
  record is temporarily unavailable because its NAS root is offline.
- `GET /api/media/items` — the catalog for a playback client.
- `GET /api/media/items/:id` — range-capable direct delivery for browser-safe
  files such as MP4/WebM.
- `POST /api/media/transcode?itemId=:id` — starts an HLS session and returns a
  tokenized playlist URL. Optional client-profile query parameters are
  `codec=h264|hevc|av1`, `backend=auto|software|nvenc|qsv|vaapi|amf|rkmpp`,
  `maxWidth`, `maxHeight`, `videoBitrateKbps`, `audioBitrateKbps`, and
  `toneMap=1`. The server chooses a verified backend for the requested codec,
  then falls back to a software encoder when that codec is available.

Third-party clients should use the stable `/api/v1` contract. Discovery and
OpenAPI metadata are available at `/api/v1/discovery` and
`/api/v1/openapi.json`; library, profile/progress, direct/download, and HLS
resources carry `X-LoomTV-API-Version: 1`. The browser client probes direct
playback first and requests HLS when the source is not browser-compatible.

Keep the admin bearer token private. HLS session tokens are scoped to one
generated session and are not accepted by administrative routes.

## Native systemd installation

Use this path when Docker is unavailable or when the NAS host is a conventional
Linux server. Create a dedicated service account and local state directories:

```sh
sudo useradd --system --home-dir /var/lib/loomtv --create-home --shell /usr/sbin/nologin loomtv
sudo install -d -o loomtv -g loomtv -m 0750 /var/lib/loomtv /var/cache/loomtv /srv/loomtv-media
sudo install -d -m 0755 /opt/loomtv /etc/loomtv
sudo cp deploy/systemd/loomtv.env.example /etc/loomtv/loomtv.env
sudo chown root:loomtv /etc/loomtv/loomtv.env
sudo chmod 0640 /etc/loomtv/loomtv.env
```

Install the server release under `/opt/loomtv` and ensure `node` is available
at `/usr/bin/node`. Mount SMB/NFS at `/srv/loomtv-media`, then install and
start the unit:

```sh
sudo cp deploy/systemd/loomtv.service /etc/systemd/system/loomtv.service
sudo systemctl daemon-reload
sudo systemctl enable --now loomtv
systemctl status loomtv
curl --fail http://127.0.0.1:3847/healthz
```

If you choose different data/cache/media paths, update both
`/etc/loomtv/loomtv.env` and the unit's `ReadWritePaths=` sandbox declaration.
For `/dev/dri` access, add the `loomtv` user to the host's `render`/`video`
groups and restart the service.

## Backup and restore

Stop LoomTV before copying `/config` or `/var/lib/loomtv` when making a
filesystem-level safety copy. This keeps the state files consistent:

```sh
docker compose stop loomtv
tar --xattrs --acls -C /srv/loomtv -czf /srv/backups/loomtv-config-$(date +%Y%m%d).tar.gz config
docker compose start loomtv
```

For systemd, use `sudo systemctl stop loomtv` and archive `/var/lib/loomtv`.
Back up `/cache` only if preserving artwork cache saves meaningful rebuild time;
it can be deleted and regenerated. Media should be protected by the NAS's own
backup/snapshot policy.

The admin backup is a checksummed, versioned JSON envelope. It includes the
headless catalog, roots, account policy, scan checkpoint, logs, and hosted
client profiles/watch progress. `POST /api/admin/backup/restore` validates the
checksum, creates a pre-restore rollback snapshot, replaces both state files,
and revokes active sessions. Restore from the admin UI or API while the server
is running; keep the generated rollback path until the restored library and
browser playback have been checked. Raw state backups from the earliest
headless release are accepted as a legacy migration format.

## Upgrades and diagnostics

1. Take a config backup.
2. Pin or record the current image digest/version.
3. For the checked-in local-build path, check out the intended release, update
   the explicit `image:` version, and rebuild. For a registry deployment,
   resolve and set the new release digest before pulling it. Run
   `docker compose up -d` (or restart the systemd unit after replacing
   `/opt/loomtv`).
4. Confirm `/healthz`, the web client, library count, and one direct/transcoded
   playback before removing the old image.

Use `docker compose logs loomtv` or `journalctl -u loomtv -f` for structured
startup and scan errors. A failed health check means the process is not serving
`/healthz`; it does not by itself mean the NAS is offline. Check the host mount
and permissions separately before attempting a destructive rescan. The
headless backup covers server-control state and the hosted browser
profile/progress adapter; it does not copy media bytes, which should be
protected by the NAS snapshot/backup policy.
