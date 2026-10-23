# Managed torrent playback

## Playback follow-up

LoomTV now checks for an already-running local Stremio service before starting
its own worker. Both paths keep the existing host grants, local relay and LoomTV
native player. If the shared service is unavailable or preparation fails, the
built-in worker is used. Closing a shared-service session aborts LoomTV's reads;
it does not stop Stremio's process, torrents or cache.

The standalone path supplies a bounded default tracker list when the provider
supplies no trackers. Failed tracker address checks omit that tracker without
disabling DHT or other valid trackers. Provider requests now use the desktop's
30-second deadline, and failure audits retain fixed error codes without URLs.

Live checks on October 22 received a 1 MiB range from the local Stremio service
and decoded 12 frames through LoomTV's host session and relay. The decoder was
stopped by the diagnostic deadline; this does not verify complete playback or
seeking. Standalone discovery remained unreliable in these checks. Full LoomTV
player verification still requires restarting the stale development host and
observing playback. Type checks passed; no test suite was run for this follow-up.

## Original implementation

Implemented October 22, 2026. No tests, peer connections, playback checks or visual checks were run for this change. Type checking, lint and source inspection are the available verification. Regression cases were added but remain unrun.

Desktop now supplies a managed WebTorrent 3.0.21 engine to the existing host playback service. The previous standalone Stremio Service client remains available to existing integration fixtures, but the desktop no longer requires Stremio to be installed or running.

## Selection and playback

A valid direct HTTPS media URL takes precedence over accompanying torrent metadata. An actual `.torrent` URL does not become a playable media URL. Valid BitTorrent v1 hash and hex magnet sources keep their host-only descriptors and require explicit selection.

The source picker retains the existing consent and file selection flow. Metadata preparation runs a separate Electron utility process for each source. No file is selected for downloading by default. The existing selection rules preserve file indexes, highlight provider choices and warn about recognizable episode mismatches.

Selecting a file transfers ownership of the process to a new host grant. Native VLC or mpv requests use the existing `/addon-media/` relay. Only the host knows the engine's ephemeral loopback port and random access token. Range reads select the pieces needed for playback and seeking. Browser torrent playback remains unsupported.

## Resource ownership

- At most four engines or pending preparations are admitted. Metadata preparation has a deadline, and abandoned file selections expire after five minutes.
- Releasing the last native relay lease starts a 30-second retry window so a decoder fallback can reopen the selected grant. The engine is then stopped on the next lifecycle sweep. Explicitly closing the grant, revoking access, changing profiles or quitting stops it immediately. A heartbeat stops an orphaned worker after the parent disappears.
- Temporary pieces use numeric filenames in a private cache directory, never torrent filenames or provider paths. Each engine has a hard 16 GiB storage limit and a 1 MiB/s upload limit. Reaching the storage limit fails playback rather than growing the cache indefinitely.
- Cache deletion follows process termination. Abandoned cache directories older than a day are swept on a later preparation. Failed deletion is best effort.
- Local peer discovery, automatic router port mapping, web seeds and native uTP are disabled. Initial tracker addresses are checked, and peer connections use a private-address blocklist. This utility process isolates failures; it is not a complete network sandbox.
- Engine startup and media failures invalidate the selected grant. The existing relay retains request, transfer and idle limits.

## Packaging and remaining verification

WebTorrent is an exact runtime dependency. The main Vite build emits the utility-process entry beside the main bundle. Forge stages the dependency tree; electron-builder includes it with the existing runtime dependencies.

Before release, verify utility-process startup in development and packaged apps, a controlled torrent download, file selection, seeking, cancellation, cache exhaustion, engine crashes, profile revocation and native-player handoff. The source-level checks performed here do not establish that playback works on a user's machine.
