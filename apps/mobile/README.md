# LoomTV Mobile

LoomTV Mobile is an Expo React Native companion app for browsing and playing a paired LoomTV desktop library from another device.

The current target is same-LAN remote playback: the desktop app remains the local media host, and the mobile app connects to the desktop address shown in LoomTV desktop settings. Internet remote streaming is not documented as supported yet and should not be exposed until authentication, network exposure, rate limiting, and transport security are reviewed.

## Current Capabilities

- Pair with a LoomTV desktop host using a desktop base URL and 6-digit pairing code.
- Browse Home, Movies, TV Shows, Anime, Settings, detail pages, and episode lists.
- Load the paired desktop library over the local network.
- Play direct mobile-compatible streams with `expo-video`.
- Request HLS/transcode sessions from the desktop app when a file format needs a mobile-compatible stream.
- Save playback progress back to the paired desktop host.
- Show continue-watching and watched/progress states from synced progress.

## Backend Foundation

The workspace includes Convex functions and schema for longer-term companion workflows:

- Host registration and heartbeat
- Pairing codes and paired device tokens
- Media and episode sync records
- Playback progress
- Remote playback control commands

The mobile app currently pairs directly with the desktop LAN API. Convex support should be treated as foundation for sync/control workflows until the full production path is documented.

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

## Pairing Flow

1. Start LoomTV desktop.
2. Enable local network sharing in desktop Settings.
3. Note the desktop address and 6-digit pairing code.
4. Open LoomTV Mobile on a device connected to the same network.
5. Enter the desktop address and pairing code.
6. Browse the synced library and start playback.

## Security Notes

- Same-LAN playback should remain opt-in from the desktop app.
- Pairing codes and device tokens should be treated as credentials.
- Do not expose the desktop LAN server directly to the public Internet.
- Remote Internet streaming requires a separate design for authentication, authorization, transport security, rate limiting, and abuse prevention.

## Known Limits

- The mobile app is an MVP companion client.
- Same-LAN streaming is the first supported target.
- Mobile playback support depends on platform codec support or successful HLS/transcode fallback.
- Setup, diagnostics, and error recovery still need polish.
