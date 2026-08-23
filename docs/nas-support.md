# NAS support

LoomTV runs its canonical server directly on a NAS, Linux host, or container. A desktop session, Electron window, and desktop relay are not required. See [nas-deployment.md](nas-deployment.md) for install and operator instructions.

## Storage model

LoomTV reads media from folders mounted by the host operating system:

- macOS mounts under `/Volumes`;
- Linux SMB/NFS mounts under paths such as `/mnt` or `/media`;
- Windows mapped drives or UNC paths available to the server process;
- container bind mounts exposed read-only at a stable container path.

The operating system or container platform owns SMB/NFS credentials. LoomTV does not store NAS usernames or passwords or implement its own SMB client.

## Implemented behavior

- One canonical database stores accounts, administrators, profiles, roots, catalog, sources, progress, lists, devices, invitations, downloads, and operational state.
- A root can be online, offline, unreadable, missing, or degraded without deleting its existing catalog records.
- Interrupted and failed scans keep the previous usable catalog.
- Quick, metadata, and full scan modes have distinct behavior.
- Storage probes distinguish missing paths, permission denial, read-only filesystems, write failure, cleanup failure, and timeout.
- Direct media and HLS transcoding read from mounted paths while public responses omit filesystem paths.
- Backup/restore covers canonical application state. Media bytes remain the responsibility of the NAS backup system.
- Docker Compose and systemd deployment examples, health checks, non-root operation, reverse-proxy guidance, and GPU device mapping are documented.

## Security boundary

- Mount media read-only when LoomTV does not need deletion permission.
- Keep the data, cache, and backup directories writable only by the server identity.
- Do not expose the server over plain HTTP to the Internet.
- Remote use requires HTTPS and the explicit trusted-proxy/remote policy. LoomTV does not configure routers or provide a hosted relay.
- Treat mount paths as sensitive. Public APIs and bounded diagnostic reports do not expose them.

## Evidence still required

- Restart and offline-mount drills on representative Synology, TrueNAS, Unraid, and generic Linux installations.
- Windows UNC verification under the actual service identity.
- Large-library scan cancellation, throttling, scheduling, and resume across process restarts.
- Hardware-transcode validation for the documented GPU passthrough combinations.
- Cross-version restore drills and recovery from damaged or read-only application storage.
