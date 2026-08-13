# LoomTV mobile automated release evidence, 2026-08-13

This record covers the local automated and unsigned native compile gates. It does not replace production signing, store artifact inspection, or the physical-device matrix in `RELEASE_CHECKLIST.md`.

## Environment

- Host: macOS on Apple silicon
- Node.js: workspace toolchain
- Android SDK: `$HOME/Library/Android/sdk`
- Java: Homebrew OpenJDK 21
- iOS target: arm64 iOS Simulator, Release configuration, code signing disabled

## Passed gates

| Gate | Command | Result |
| --- | --- | --- |
| Mobile source contracts | `npm test` from `apps/mobile` | 60 of 60 passed |
| TypeScript | `npm run typecheck` from `apps/mobile` | Passed |
| Release configuration | `pnpm mobile:verify-release-config` | Passed |
| Android fail-closed configuration | `pnpm mobile:verify-android-config` | Passed |
| Clean native generation | `npx expo prebuild --clean --no-install` | Passed |
| CocoaPods integration | `pod install --project-directory=ios` | Passed |
| Android Release compile | `./gradlew :app:assembleRelease` from `apps/mobile/android` | Passed, unsigned artifact |
| iOS Release compile | `xcodebuild -workspace ios/LoomTVMobile.xcworkspace -scheme LoomTVMobile -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/loomtv-ios-release-2 ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build` | Passed |

The iOS release-hardening plugin also corrects generated pod deployment targets and quotes generated build-script paths, so clean prebuilds work when the repository path contains spaces.

## Automated behavior covered

- Payload decoding, including malformed and oversized error payloads.
- Diagnostic redaction, seven-day retention, 100-event retention, and a 256 KB byte cap.
- Certificate pinning and same-host mDNS address updates.
- Per-operation LAN deadlines, caller cancellation, lifecycle cancellation, and typed timeout errors.
- Offline cache revision semantics and active versus orphaned progress retention.
- Core media selection that excludes Others while preserving direct playback for Others.
- Playback clock, profile gates, orientation recovery, and safe failure paths.
- AppRoot architecture contract: connection/session, navigation/modal, and playback ownership remain behind dedicated controllers with a bounded composition-hook budget.

## Evidence still required

- Production EAS artifacts with the intended Android signer and iOS signing identity and entitlements.
- iPhone, iPad, Android phone, and Android tablet matrix results.
- Home and office Wi-Fi discovery, captive portal, packet loss, address change, and desktop sleep results.
- VoiceOver, TalkBack, maximum text size, reduced motion, focus order, announcements, and target-size evidence.
- Measured cold and warm offline startup, cached-artwork completion, one-hour playback writes, and render counts.
