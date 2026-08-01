# LoomTV Mobile

LoomTV Mobile is the Expo React Native companion for browsing and playing a paired Loom Media Player desktop library from an iPhone, iPad, Android phone, or Android tablet.

The supported target is same-LAN remote playback: the desktop app remains the local media host, and the mobile app connects to the desktop address shown in Loom Media Player desktop settings. Internet remote streaming is not supported and should not be exposed until authentication, network exposure, rate limiting, and transport security are reviewed.

## Supported Capabilities

- Pair with a Loom Media Player desktop host using a desktop base URL and 6-digit pairing code.
- Browse Home, Movies, TV Shows, Anime, Settings, detail pages, and episode lists.
- Load the paired desktop library over the local network.
- Play direct mobile-compatible streams with `expo-video`.
- Request HLS/transcode sessions from the desktop app when a file format needs a mobile-compatible stream.
- Save playback progress back to the paired desktop host.
- Show continue-watching and watched/progress states from synced progress.
- Switch and lock profiles, honor automatic sign-in, and keep favorites/My List profile-scoped.
- Reconnect automatically after an address change or temporary desktop/Wi-Fi outage.
- Browse the last saved metadata catalog during a cold-start outage for an automatic-sign-in profile; playback and mutations remain disabled until the desktop reconnects.

## Development

From the repository root:

```sh
corepack pnpm mobile:start
```

Platform-specific commands:

```sh
corepack pnpm mobile:ios
corepack pnpm mobile:android
corepack pnpm mobile:web
```

LAN pairing and playback use the app-local `loomtv-secure-transport` Expo module. Use an iOS/Android development or store build after native changes; Expo Go and the web target do not contain the pinned native transport.

Android native projects are generated from the tracked Expo configuration. Run
`corepack pnpm mobile:verify-android-config` from the repository root to validate
the tracked policy; when `apps/mobile/android` exists, the same command also
checks its application ID, version, cleartext/network policy, and Gradle wrapper
checksum. CI performs a clean Expo prebuild and requires the generated checks.

## Preview and Store Builds

The tracked [`eas.json`](./eas.json) defines installable Android/iOS preview builds, an iOS Simulator build, and auto-incrementing production builds. Install and authenticate the EAS CLI, then run from this directory:

```sh
corepack pnpm build:preview:android
corepack pnpm build:preview:ios
corepack pnpm build:simulator:ios
corepack pnpm build:production
```

Validate the release contract first from the repository root:

```sh
corepack pnpm mobile:verify-release-config
corepack pnpm mobile:verify-android-config
```

Before submission, complete every platform and scenario in [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). Apple/Google signing credentials and the initial Expo project link are account-owned setup and are intentionally not stored in Git.

## Pairing Flow

1. Start Loom Media Player desktop.
2. Enable local network sharing in desktop Settings.
3. Note the desktop address and 6-digit pairing code.
4. Open LoomTV Mobile on a device connected to the same network.
5. Enter the desktop address and pairing code.
6. Browse the synced library and start playback.

## Security Notes

- Same-LAN playback should remain opt-in from the desktop app.
- Pairing codes and device tokens should be treated as credentials.
- LAN API, artwork, and media traffic is sent to the desktop TLS listener through a native certificate-pinned loopback proxy. The proxy streams bytes natively and reuses TLS connections; it does not copy media through the JavaScript bridge.
- Saved connections without a certificate fingerprint are intentionally incompatible and must be paired again once.
- Do not expose the desktop LAN server directly to the public Internet.
- Remote Internet streaming requires a separate design for authentication, authorization, transport security, rate limiting, and abuse prevention.

## Known Limits

- Same-LAN streaming is the supported target.
- Mobile playback support depends on platform codec support or successful HLS/transcode fallback.
- The offline catalog contains metadata only; downloaded media is a separate future feature.
- Internet remote streaming, casting, TV clients, and multiple saved servers are separate feature tracks.
