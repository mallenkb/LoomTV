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
