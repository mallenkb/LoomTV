# LoomTV Mobile

LoomTV Mobile is the Expo React Native client for browsing and playing a canonical LoomTV server from an iPhone, iPad, Android phone, or Android tablet.

The default target is same-LAN playback. The canonical server may run inside the desktop app or independently on a NAS. An operator may also provide remote HTTPS through LoomTV's trusted-proxy and remote-access policy; the project does not ship a relay or automatic router exposure.

## Supported Capabilities

- Discover or enter a LoomTV server, confirm its certificate, and complete device pairing.
- Browse Home, Movies, TV Shows, Anime, Settings, detail pages, and episode lists.
- Load the canonical server library over the local network or operator-provided HTTPS endpoint.
- Play direct mobile-compatible streams with `expo-video`.
- Request HLS/transcode sessions when a file format needs a mobile-compatible stream.
- Save playback progress to canonical profile state.
- Show continue-watching and watched/progress states from synced progress.
- Switch and lock profiles, honor automatic sign-in, and keep favorites/My List profile-scoped.
- Reconnect automatically after an address change or temporary server/Wi-Fi outage.
- Browse the last saved metadata catalog during a cold-start outage for an automatic-sign-in profile and play media previously downloaded into app storage.

## Development

The LAN discovery and secure transport modules are native code. Install the
custom development build first:

```sh
corepack pnpm mobile:ios
# or
corepack pnpm mobile:android
```

After it is installed, start Metro for that native app from the repository root:

```sh
corepack pnpm mobile:start
```

For a clean machine or a physical device, the equivalent EAS development-client
builds are:

```sh
corepack pnpm --filter @loom-media-server/mobile build:development:ios
corepack pnpm --filter @loom-media-server/mobile build:development:android
corepack pnpm --filter @loom-media-server/mobile build:development:simulator:ios
```

Install the resulting build first, then run `corepack pnpm mobile:start`. If
Metro reports `No development build (app.loomtv.mobile) ... is installed`, the
native binary is missing on the selected simulator/device; run
`corepack pnpm mobile:ios` for a local iOS build (or the Android equivalent)
before starting Metro.

The start command deliberately targets the LoomTV development client. Do not
open this project in Expo Go: Expo Go does not contain Bonjour discovery or the
certificate-pinned LAN transport. If the app says a development/store build is
required, rerun the platform command above and launch **LoomTV Mobile**.

The web-only UI can still be started separately:

```sh
corepack pnpm mobile:web
```

LAN pairing and playback use the app-local `loomtv-secure-transport` Expo module. Use an iOS/Android development or store build after native changes; Expo Go and the web target do not contain the pinned native transport.

Android native projects are generated from the tracked Expo configuration. Run
`corepack pnpm mobile:verify-android-config` from the repository root to validate
the tracked policy; when `apps/mobile/android` exists, the same command also
checks its application ID, version, cleartext/network policy, and Gradle wrapper
checksum. CI performs a clean Expo prebuild and requires the generated checks.

## Preview and Store Builds

The tracked [`eas.json`](./eas.json) defines native development clients,
installable Android/iOS preview builds, an iOS Simulator build, and
auto-incrementing production builds. Install and authenticate the EAS CLI, then
run from this directory:

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

1. Start LoomTV desktop hosting or the standalone NAS server.
2. Confirm the server advertises its HTTPS address and certificate fingerprint.
3. Open LoomTV Mobile on a device connected to the same network.
4. Tap **Connect** beside the discovered server.
5. Approve the named device as an administrator.
6. If discovery is unavailable, use **Connect manually** with the HTTPS server address and confirm the certificate fingerprint.
7. Browse the synced library and start playback. Future connections use the saved, scoped device credential automatically.

## Security Notes

- Pairing and remote access remain owner-controlled server policies.
- Desktop approval requests expire after one minute. Pairing PINs and device tokens should be treated as credentials.
- API, artwork, download, and media traffic is sent to the server TLS listener through a native certificate-pinned loopback proxy. The proxy streams bytes natively and reuses TLS connections; it does not copy media through the JavaScript bridge.
- Saved connections without a certificate fingerprint are intentionally incompatible and must be paired again once.
- Do not expose a LoomTV server over cleartext HTTP to the public Internet. Remote deployments require HTTPS, an explicit trusted-proxy allowlist, and enabled remote policy.

## Known Limits

- Same-LAN streaming is the default target. An operator may provide remote HTTPS through the server's trusted-proxy policy; LoomTV does not ship a relay or automatic router configuration.
- Mobile playback support depends on platform codec support or successful HLS/transcode fallback.
- The app can create a scoped server download lease, stream the file into app document storage through the pinned transport, play it offline, and remove it. Complete the release checklist on physical devices before treating large or interrupted downloads as production-verified.
- Android TV and Fire TV use the separate `apps/tv` client. Multiple saved-server switching and an Android Chromecast sender remain future client work.
- iOS external playback is supplied by the native video stack; browser casting has an explicit canonical cast session. Receiver compatibility still requires physical AirPlay/Chromecast testing.
