# Mobile 9.5 release gate

A score of 9.5 or higher requires all automated and physical-device evidence below. Static source inspection is not sufficient.

## Automated artifacts

- The release-boundary verifier passes.
- Android and iOS Release configurations compile from a clean prebuild.
- The Android artifact permission list matches the allowlist and does not use the debug signer.
- Offline snapshot writes remain bounded during a one-hour playback trace.
- Contract tests prove that Others IDs never appear in Home, anime, TV, movie, hero, My List, or core search results.
- Request cancellation tests prove no LAN request survives navigation, backgrounding, disconnect, retry, or its deadline.

## Physical-device matrix

Record artifact links, OS versions, and results for iPhone, iPad, Android phone, and Android tablet. Each device must pass:

- Bonjour discovery and manual HTTPS pairing on home Wi-Fi and office Wi-Fi.
- Cold online launch, cold offline launch, warm offline launch, and image-complete timing at p50 and p95.
- Desktop sleep, address change, captive portal, packet loss, and reconnect recovery.
- Direct playback for Others with zero detail-page or core-surface leakage.
- HLS, direct play, subtitle, audio-track, orientation, background, resume, and scrub journeys.
- Maximum text size, reduced motion, VoiceOver or TalkBack, switch access, and 44 by 44 point minimum targets.

## 9.5 acceptance thresholds

- Zero critical or high-priority findings remain.
- Every scored category is at least 9.5 from recorded evidence.
- Offline metadata is available without network access and cached artwork meets the agreed p95 target.
- One hour of playback produces bounded, incremental persistence rather than catalog-sized writes.
- Production artifacts are signed only by the intended release identity.
