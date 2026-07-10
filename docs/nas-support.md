# NAS Support Plan

Loom Media Server should support network-attached storage as a first-class source for local media libraries. The desktop app remains the media host: it reads from local disks or mounted NAS shares, then serves playback to the desktop player or paired mobile clients.

## Support Model

Initial NAS support should rely on operating-system mounted shares:

- macOS: SMB/NFS shares mounted in Finder or under `/Volumes`
- Windows: mapped drives or UNC paths where Electron and Node file APIs can read reliably
- Linux: mounted SMB/NFS shares under a user-accessible mount point

Loom Media Server should not manage NAS usernames, passwords, or raw SMB/NFS sessions until there is a clear security design. Letting the OS own credentials keeps the first version simpler and safer.

## User Experience Goals

- Users can add a mounted NAS folder to Movies, TV Shows, Anime, or Others.
- Settings clearly shows whether each NAS folder is available, disconnected, or scanning.
- A disconnected NAS folder does not erase the user library during a scan.
- Playback errors explain whether the file is missing, the NAS is offline, or transcoding failed.
- Mobile clients can stream from the desktop host without mounting the NAS themselves.

## Technical Work

### Path Availability

- Check folder availability before scan and playback.
- Distinguish missing local folders from temporarily unavailable network mounts.
- Preserve scan cache and media rows when a NAS folder is offline.
- Add tests for missing folders, offline shares, and scan-cache preservation.

### Scan Performance

- Keep incremental scanning and avoid full rescans unless requested.
- Cache folder signatures and file counts without repeatedly probing every file.
- Make scans resumable or at least safely interruptible for large libraries.
- Avoid blocking UI updates while scanning high-latency shares.

### Playback

- Validate that direct stream and HLS/transcode paths can read from mounted NAS paths.
- Surface slow-read or unavailable-file errors clearly.
- Avoid starting expensive transcode work until the user actually opens playback.
- Keep mobile playback routed through the desktop LAN API so the phone does not need NAS credentials.

### Security and Privacy

- Do not log NAS credentials.
- Avoid storing NAS credentials in Loom Media Server settings.
- Treat NAS paths as potentially sensitive in logs and diagnostics.
- Keep LAN sharing opt-in.
- Do not expose a NAS-backed library outside the local network without a separate remote-access security design.

## Open Decisions

- Should Windows UNC paths be accepted directly, or should users map drives first?
- Should Loom Media Server show a NAS-specific folder type, or infer network storage from path/mount metadata?
- Should scans skip unavailable folders by default or prompt the user?
- Should large NAS libraries have configurable scan concurrency?
- Should the mobile app show when an item is unavailable because the desktop host cannot reach the NAS?
