# LoomTV add-on playback implementation plan

Prepared October 22, 2026.

Status: first Stremio Service integration implemented, runtime-unverified. See [integration scope and remaining verification](stremio-service-integration.md). Later capability inspection, conversion, detailed transfer progress and playback-outcome history remain proposed.

## Objective

Select the intended movie or episode, load supported sources reliably, and explain failures accurately. Reuse LoomTV's add-on adapter, host-controlled playback sessions, local relay, source picker and players.

Content matching and playback health are separate concerns. A playable file can contain the wrong episode. Filename matching provides evidence, not proof of content identity.

## Existing foundation

The inspected code already provides:

- Host-owned playback references and profile-scoped session authorization.
- A local media relay with cancellation and revocation.
- Incremental source loading and refresh handling.
- Basic media detection and HLS playlist handling.
- Native and browser playback paths.

The main gaps are torrent playback, reliable file selection and detailed playback status. These existing paths have not been runtime-verified as part of this plan.

## Initial scope

Deliver desktop HTTPS media, currently supported HLS, and torrent playback with explicit file selection and useful failure reporting. Keep DASH, Usenet, archive extraction and broader platform support as separate compatibility additions.

Do not run tests until the user explicitly requests them. Static inspection is allowed. Implementation can proceed before runtime verification, but must remain described as unverified.

## Phase 1: Correct source classification

Primary integration point: `packages/stremio-adapter/src/stremio-adapter.mjs` and its TypeScript contracts.

- Distinguish direct media, HLS, torrents and external links.
- Prefer a valid direct media URL when a source also contains torrent metadata.
- Recognize magnet links and torrent-file URLs separately from video URLs. Do not assume every HTTPS URL points to media.
- Preserve validated torrent hashes, file indexes and tracker information for the host.
- Separate protocol support from observed playback success. Installed, enabled and supported must not imply verified playback.
- Preserve explicit rejection reasons for unsupported transports and malformed responses.
- Keep protocol contracts, host normalization and renderer summaries consistent.

Completion criteria: mixed direct-URL/torrent-metadata sources can take the direct media path, while torrent-only sources retain the information required by a torrent engine.

## Phase 2: Preserve content identity and select the right file

Carry a structured playback target through source discovery, grants and sessions. Include the provider content ID, movie or series ID, episode ID, and season/episode information where available. Bind the selected source to that target and the active profile.

File selection rules:

1. Honor a valid explicit file index using the torrent's original file ordering. Do not reorder files before applying the index.
2. Detect obvious conflicts between the requested episode and the selected filename. Surface the conflict rather than silently substituting another file.
3. Without an explicit index, exclude samples, trailers and non-video files, then select only an unambiguous match.
4. Show a file picker when multiple plausible files remain or matching evidence conflicts.
5. Do not silently choose the largest file in a season pack.

Handle anime absolute numbering, specials and multi-episode files explicitly. Avoid converting uncertain identifiers into guessed season/episode values. Retain whether a match came from the provider, filename inference or user selection.

Completion criteria: every selection retains its requested target and selected file, and ambiguous selections require a user choice. The UI must not claim that filename matching proves content identity.

## Phase 3: Connect the official Stremio Service

Use the official, separately installed Stremio Service at its local endpoint. Do not substitute WebTorrent or bundle Stremio server code. Check the service API and version before creating a torrent. Bundling would require separate distribution, packaging and update decisions.

Extend `apps/desktop/src/main/stremioPlayback.ts` to support distinct HTTPS and torrent source descriptors behind the same playback-session interface. Do not weaken the HTTPS fetch policy to accommodate torrent networking.

- Start torrent activity only after source selection and the applicable playback permission.
- Retrieve torrent metadata, resolve the selected file, and prioritize pieces required for playback and seeking.
- Serve byte ranges through the existing token-protected local relay.
- Keep opaque playback references in the renderer. The host owns LoomTV playback sessions; Stremio owns its engine lifecycle.
- Bound LoomTV metadata requests, relay transfers and concurrent sessions. Cache, upload and process-wide resource settings remain in Stremio.
- Treat returned metadata as untrusted. Never send arbitrary filesystem paths, engine options or provider credentials to the service.
- Validate tracker inputs, but do not claim to sandbox Stremio's later DNS, peer or filesystem activity.
- Close LoomTV's requests when authorized playback ends. Do not remove torrents or stop the shared service, which could disrupt other clients. Do not promise immediate termination of Stremio downloads or uploads.
- Apply profile changes, add-on revocation, cancellation and app shutdown to LoomTV sessions.
- Report service failure and allow a new explicit attempt after it restarts.

Completion criteria: the existing players can consume a selected torrent file through a local media URL, with session cleanup and authorization preserved.

## Phase 4: Validate media and choose a playback path

Extend existing inspection to identify the actual container, video and audio tracks, and seeking behavior. Inspect only the selected source using bounded requests and timeouts.

- Reject HTML error pages and malformed responses with a useful explanation.
- Use the selected native player when its capabilities match the media.
- Use browser playback only when compatible.
- Reuse existing remuxing or transcoding infrastructure where suitable, preserving cancellation and session ownership.
- Report unsupported codecs and DRM explicitly.
- Keep transport availability, media recognition and successful player startup as distinct outcomes.

Completion criteria: the host selects a justified playback path or returns a specific failure. A successful HTTP response alone does not count as working playback.

## Phase 5: Show progress and recover predictably

Extend `apps/desktop/src/lib/addonPlayback.ts`, `apps/desktop/src/components/AddonSourcePicker.tsx` and the player integration.

Expose useful states:

`Finding sources → Loading metadata → Selecting file → Buffering → Playing`

Allow cancellation and failure from every active stage. Ignore late results from superseded requests or profile changes.

- Distinguish configuration errors, expired links, unavailable peers, timeouts, unsupported media and engine failures.
- Keep technical diagnostics separate from user-facing messages. Remove credentials and configured private URLs from diagnostics.
- Retry transient failures within bounded limits.
- Refresh expired sources while retaining the requested title and episode. Reconfirm file selection if refreshed source details differ.
- Offer another source when recovery fails. Do not silently switch content or begin torrent activity after an HTTPS failure.
- Record recent playback outcomes per source and device capability, with timestamps and expiration.
- Do not mark an entire add-on broken because one source fails.
- Enter the playing state only after meaningful player progress, not just connection success.

Completion criteria: users can understand the current stage, cancel it, and distinguish retryable failures from configuration or compatibility problems.

## Phase 6: Verification and release readiness

Prepare verification coverage during implementation, but execute tests only after explicit user authorization.

Required scenarios:

- Direct media URLs accompanied by torrent metadata.
- Single-file torrents and multi-file season packs.
- Explicit file indexes, conflicting episode labels and ambiguous filenames.
- Anime numbering, specials, samples and multi-episode files.
- Startup buffering, forward/backward seeking and stalled transfers.
- Expired credentials, malformed media responses and unavailable peers.
- Cancellation during metadata loading, probing, buffering and playback.
- Profile changes and add-on revocation during active playback.
- Shared-service coexistence, Stremio cache settings, disk exhaustion and service restarts.
- Packaged desktop execution, including engine dependencies and player integration.

Use controlled media and deterministic fixtures for repeatable checks. After authorization, verify actual playback and seeking in the packaged app as well as development mode. Follow the user's background-testing and window-focus restrictions.

Completion criteria: report which scenarios passed, which remain unsupported and which were not run. Do not describe playback as reliable solely because static checks pass.

## Delivery order

1. Correct classification and carry content identity through existing HTTPS playback.
2. Add explicit file selection and the Stremio Service adapter behind a per-selection torrent opt-in.
3. Connect torrent sessions to the existing relay and players.
4. Add media capability decisions, progress reporting and bounded recovery.
5. Complete authorized verification before enabling the feature by default.

Keep each delivery reviewable and preserve existing library playback. Do not add broad format support to the first torrent milestone.

## References

- [Stremio add-on manifest specification](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html)
- [Stremio stream specification](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html)
- [Stremio Service overview](https://blog.stremio.com/using-stremio-service/)
- [Stremio streaming server requests](https://github.com/Stremio/stremio-core/blob/development/src/types/streaming_server/request.rs)
- [Stremio EngineFS routes](https://github.com/Stremio/enginefs/blob/master/enginefs.js)
