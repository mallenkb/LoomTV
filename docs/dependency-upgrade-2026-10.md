# October 2026 dependency upgrade

Updated workspace dependencies and the Rust scanner on `codex/try-tsrs`. Existing uncommitted compiler, lint, and application changes were preserved.

## Versions and compatibility holds

| Area | Version |
| --- | --- |
| Expo, mobile and TV | 58.0.16 |
| React Native | 0.88.0 |
| React and React DOM | 19.3.0, aligned with Expo 58 |
| Expo's TypeScript JavaScript API | 6.0.3 |
| Workspace compiler | tsrs 0.18.0-ts7.1.0-dev.20260929 |
| Electron | 44.9.0 |
| Electron Forge | 8.0.1 |
| Vite Plus and its Vite core alias | 1.3.0 |
| Oxlint | 1.89.0 |
| better-sqlite3 | 13.0.3 |
| Rust SHA-2 | 0.11.1 |

Other direct dependencies were updated to their latest compatible releases available under the repository's 24-hour release-age policy. Electron 44.9.1 and Lucide 1.60.0 were inside that window during the upgrade. React 19.3.1 remains deferred to keep the Expo compatibility set aligned. Node types stay on the latest Node 22 release to match CI. TypeScript 7 does not replace the JavaScript compiler API used by Expo tooling.

## Source and configuration changes

- Migrated React Native refs to instance types, removed obsolete stylesheet and blur APIs, handled nullable native handles and app state, and awaited the asynchronous file move API.
- Updated the router error fallback for unknown thrown values.
- Migrated the Forge packaging hook and better-sqlite3 native binary paths. React aliases now resolve installed packages instead of assuming a nested dependency directory.
- Raised the mobile iOS minimum to 16.4. Updated Gradle to 9.4.1 with its published SHA-256 checksum.
- Regenerated tracked Android TV configuration from Expo 58, preserving its existing assets and debug keystore. Mobile native generation was checked in a temporary copy; existing ignored mobile native directories were preserved.
- Removed the obsolete Forge and image-size patches, ported the zeroconf patch, and removed the two obsolete image-size audit waivers.
- Updated Rust dependencies and adapted digest formatting while preserving the inventory signature format.
- Pruned the packaged better-sqlite3 module to the target's Node-API prebuild. Version 13 ships prebuilds for eight platforms plus the SQLite sources, about 26 MB the app never loads. The same prebuild loads in Node and Electron, so the `ensure-node-natives`/`ensure-electron-natives` rebuild steps, the `rebuild:natives` script and the direct `@electron/rebuild` dependency were removed. Tests and `pnpm start` no longer recompile better-sqlite3.
- Raised the renderer chunk warning to 590 kB. hls.js 1.7 is about 575 kB and loads only when HLS playback starts; `hls.js/light` would fit but drops subtitles and alternate audio.
- Release builds failed: electron-builder's `npmRebuild` step calls `@electron/rebuild`, whose `node-abi` table does not list Electron 44.9.0. better-sqlite3 is the only native production dependency and ships prebuilds, so `npmRebuild` is now `false`.
- Forge 8 packaging failed on `.bin` symlinks that point outside the package. The `afterPrune` copy now skips `.bin` folders.
- electron-builder now leaves renderer-only packages out of `app.asar`, because Vite already bundles them into `.vite/renderer`. The main bundle requires none of them. hls.js keeps `package.json` and `dist/hls.min.js`, because the bundled web client serves that file to browsers.
- Set six newly enabled Oxlint React compiler rules to warnings. Existing lint errors remain enforced; 174 warnings need separate component review.

## Verification

Passed:

- Frozen pnpm installation and peer dependency checks.
- Expo package compatibility checks for mobile and TV.
- All six workspace typechecks and plugin-protocol declaration generation.
- Desktop production build.
- Mobile iOS and Android JavaScript exports, and Android TV JavaScript export.
- Mobile iOS/Android and TV Android native project generation in a temporary copy.
- Mobile generated Android policy checks, mobile release configuration checks, and TV configuration checks.
- Rust `cargo check --locked`.
- Lint with zero errors and 174 warnings.
- Production dependency audit with zero actionable moderate-or-higher advisories. The existing patched node-forge and braces waivers remain.

On 2026-10-21 every workspace test suite passed (1,422 tests, 0 failures) along with the scanner's Rust tests. A development run first failed because Forge 8 emits `preload.cjs`; the window now loads that name.

tsrs 0.18 publishes binaries for Apple silicon and Linux only. CI type checks run on Linux and macOS arm64 runners, but type checks on a Windows or Intel Mac machine will fail.

A release-style macOS arm64 build (`dist:adhoc`) passes `verify:runtime`. It launched with an empty data directory, created its database, and loaded LibVLC, libmpv and the updater. Compared with the installed 2.0.28:

| Part | 2.0.28 | This branch |
| --- | ---: | ---: |
| LoomTV.app | 670 MB | 627 MB |
| app.asar | 99 MB | 17 MB |
| better-sqlite3 (unpacked) | 14 MB | 2 MB |
| Electron Framework | 226 MB | 238 MB |

LibVLC and mpv sizes depend on the locally staged runtimes, so they are not compared. The hosted web client's `/app/hls.min.js` route was not exercised, because it needs a completed first-run setup. The Forge `pnpm package` output also passes `verify:runtime` once the local LibVLC `runtime-manifest.json` is regenerated; the copy here predates the removal of VLC's Lua web interface. Native applications and installers were not compiled or exercised. Android compilation requires Java and Android SDK 37; this machine had no discoverable Java runtime and only SDK 36/36.1. iOS CocoaPods installation and Xcode compilation remain outstanding. Regenerate the local mobile native projects before the next native build, preserving any local native edits first.

The optional mobile web export requires react-native-web, which was already absent and was not added as part of the native app upgrade.
