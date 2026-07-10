# Future Work

## Renderer Bundle Splitting

The production renderer bundle is currently over Vite's default 500 kB warning threshold. This is not a release blocker, but it is worth improving later for faster app startup and less upfront JavaScript parsing.

Safe first pass:
- Add route-level lazy loading for Settings, detail pages, artwork/editor screens, and other rarely opened renderer views.
- Keep shared shell/navigation/search loaded eagerly.
- Keep the video playback path unchanged for the first pass.

Avoid in the first pass:
- Do not split or rewrite `VideoPlayer.tsx`.
- Do not lazy-load `hls.js` separately yet.
- Do not change subtitle rendering, buffering, transcode startup, media server behavior, or player controls.

Expected impact:
- Faster initial renderer startup.
- No intended change to video rendering quality, subtitle timing, buffering, HLS/transcode behavior, or playback performance.
- A rarely opened route may show a brief loading state the first time it is opened.

## Upcoming NAS Support

Mounted NAS shares can be used as library folders today when the operating system exposes them as normal readable paths. Full NAS support is planned for future releases so network-attached libraries are safer and easier to maintain.

Upcoming work:
- Add a dedicated NAS setup flow for mounted SMB/NFS shares.
- Add reconnect, offline, scanning, and unavailable states for NAS-backed folders.
- Protect saved library data when a NAS mount is temporarily disconnected.
- Add NAS-aware scan throttling or resumable scanning for large network libraries.
- Decide and document whether Windows UNC paths are supported directly or require mapped drives.
- Improve error messages so users can tell the difference between NAS offline, file missing, and transcode failure states.
- Keep paired mobile playback routed through the desktop host so mobile devices do not need NAS credentials.

## React Native Companion Client

The Expo React Native mobile client is in progress. The intended first release target is same-LAN companion playback from a paired desktop host, not standalone mobile NAS access or Internet remote streaming.

Upcoming work:
- Finish and verify pairing against the desktop LAN API.
- Polish library browsing, detail pages, episode lists, and continue-watching states.
- Verify direct stream and HLS/transcode playback on iOS and Android.
- Sync playback progress back to the desktop host reliably.
- Document mobile setup, known limits, and troubleshooting steps.
- Keep NAS-backed playback routed through the desktop host so the mobile app does not need NAS credentials.
