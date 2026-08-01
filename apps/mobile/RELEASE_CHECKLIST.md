# LoomTV Mobile release checklist

This checklist is the release gate for the same-LAN iOS and Android companion. A production build is not ready to publish until every required row has a dated result and an issue link for any exception.

## Build artifacts

1. Install and authenticate the EAS CLI: `npm install --global eas-cli && eas login`.
2. Run `corepack pnpm mobile:verify-release-config` and `corepack pnpm mobile:verify-android-config` from the repository root.
3. From `apps/mobile`, create installable builds with `corepack pnpm build:preview:android` and `corepack pnpm build:preview:ios`.
4. For simulator-only iOS checks, run `corepack pnpm build:simulator:ios`.
5. After the preview matrix passes, run `corepack pnpm build:production`; submit only the reviewed build with `corepack pnpm submit:production`.

The first EAS build will ask the project owner to connect the Expo project and provision Apple/Google signing credentials. Those account-owned values must stay in EAS or the store portals, never in this repository.

## Required device matrix

Record the device, OS version, build URL, tester, date, and result for each row.

| Target | Minimum coverage | Result |
| --- | --- | --- |
| iPhone | Oldest supported iOS and current iOS | Pending |
| iPad | One compact and one regular-width layout on current iPadOS | Pending |
| Android phone | Android 7/API 24 and current Android | Pending |
| Android tablet | One compact and one expanded-width layout | Pending |

## Required scenarios on every platform

- Fresh install: local-network permission, automatic discovery, manual HTTPS address fallback, and 6-digit PIN pairing.
- Relaunch: saved credential restore, token refresh, profile picker, automatic sign-in, PIN rejection, lockout copy, profile lock, and device disconnect.
- Library: Home rails, Movies, TV Shows, Anime, Others, search, filters, favorites/My List, detail pages, seasons, and empty-library states.
- Playback: direct play, HLS fallback, resume, seek, pause, audio/subtitle selection, subtitle sizing, skip markers, next-episode autoplay, background/foreground, orientation changes, failure retry, and return to portrait.
- Progress: continue-watching order, watched state, per-profile isolation, and progress recovery after an interrupted request.
- Network recovery: desktop stopped at launch, desktop stopped while browsing, Wi-Fi removed/restored, host address changed with the same pinned identity, revoked device, and certificate mismatch.
- Offline metadata: an automatic-sign-in profile can browse its last saved catalog while the desktop is unavailable; playback and mutations stay blocked; reconnect replaces stale metadata. PIN/manual profiles must not restore cached content while locked.
- Accessibility: screen-reader labels for primary controls, Dynamic Type/font scaling, reduced motion, contrast in light/dark themes, keyboard avoidance, and touch target sizing.
- Release surfaces: icons, splash, app name/version, privacy/local-network prompts, open-source notices, crash-free launch, and no cleartext remote traffic.

## Scope boundary

The mobile release is a paired same-LAN companion. Internet remote streaming, offline media downloads, casting, TV clients, and multiple saved servers are separate feature tracks and are not release blockers for this client.
