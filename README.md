# LoomTV

LoomTV is a desktop media library app for browsing and playing a local collection of movies, TV shows, and anime. It is built with Electron Forge, Vite, React, TypeScript, Tailwind CSS, and a local SQLite-backed library.

This project is for organizing and playing media files that you own, have created, or are otherwise authorized to use. LoomTV does not provide movies, TV shows, anime, streaming subscriptions, or copyrighted media.

![LoomTV empty library home screen](docs/screenshots/loomtv-home-empty-library.png)

## Screenshots

### Empty Library

![LoomTV empty library setup screen](docs/screenshots/loomtv-home-empty-library.png)

### Settings

![LoomTV library folder settings](docs/screenshots/loomtv-settings-library.png)

![LoomTV local network sharing settings](docs/screenshots/loomtv-settings-network.png)

![LoomTV theme customization settings](docs/screenshots/loomtv-settings-theme.png)

![LoomTV about and update settings](docs/screenshots/loomtv-settings-about.png)

## Features

- Browse separate Movies, TV Shows, and Anime libraries.
- Search across the local library from the home screen.
- Scan local folders and organize media by library type.
- Fetch posters, backdrops, cast data, ratings, and summaries from metadata providers.
- Continue watching with saved playback progress.
- Play local media with direct stream and HLS/transcode fallback support.
- Generate thumbnails and inspect local media details with bundled FFmpeg/FFprobe resources.
- Customize artwork, theme color, loader style, and sidebar ordering.
- Back up the local database from Settings.

## Download

Prebuilt desktop releases, when available, are published from the repository releases page:

https://github.com/mallenkb/LoomTV/releases

Download the installer or archive for your operating system, then run it like any other desktop app. If no release is available for your platform, build the app locally from source using the instructions below.

## Release Notes

- [LoomTV 1.0.53](docs/releases/v1.0.53.md): refreshes the desktop identity and interface, hardens local renderer access, and improves LAN pairing, updates, subtitles, and playback controls.
- [Loom Media Server 1.0.52](docs/releases/v1.0.52.md): fixes ad-hoc macOS release signing so Electron Framework loads correctly on launch.
- [Loom Media Server 1.0.51](docs/releases/v1.0.51.md): rebuilds the desktop SQLite native module against Electron before packaging.
- [Loom Media Server 1.0.50](docs/releases/v1.0.50.md): fixes desktop release CI by aligning the GitHub Actions pnpm version with the workspace toolchain.
- [Loom Media Server 1.0.49](docs/releases/v1.0.49.md): republishes the current desktop build with fresh installers and updater metadata.
- [Loom Media Server 1.0.48](docs/releases/v1.0.48.md): improves skip-analysis scheduling, manual scan responsiveness, playback protection, and library coverage reporting.
- [Loom Media Server 1.0.47](docs/releases/v1.0.47.md): makes intro/outro skipping easier to discover while keeping advanced analysis and manual timestamp controls available on demand.
- [Loom Media Server 1.0.46](docs/releases/v1.0.46.md): hardens desktop library scans against duplicate items, stale metadata, and overlapping scan runs.
- [Loom Media Server 1.0.45](docs/releases/v1.0.45.md): makes skip-marker lookups durable and retries empty or partial provider results during playback.
- [Loom Media Server 1.0.44](docs/releases/v1.0.44.md): fixes skip-marker provider timeouts so desktop CI and playback recovery complete reliably.
- [Loom Media Server 1.0.43](docs/releases/v1.0.43.md): adds desktop skip-marker analysis, playback prompts, and packaged fingerprint support.
- [Loom Media Server 1.0.42](docs/releases/v1.0.42.md): improves desktop playback recovery, transcoding behavior, and macOS release validation.
- [Loom Media Server 1.0.41](docs/releases/v1.0.41.md): removes desktop CI and React warnings and keeps playback-rate updates isolated from media source binding.
- [Loom Media Server 1.0.40](docs/releases/v1.0.40.md): preserves existing library metadata, artwork selections, and episode state during folder scans.
- [Loom Media Server 1.0.39](docs/releases/v1.0.39.md): refreshes navigation icons, library layout sizing, settings presentation, and library-section visibility across the app surfaces.
- [Loom Media Server 1.0.38](docs/releases/v1.0.38.md): fixes macOS update replacement and automatic relaunch across the LoomTV-to-Loom Media Server rename.
- [Loom Media Server 1.0.37](docs/releases/v1.0.37.md): ships the refreshed desktop architecture, packaging pipeline, and library/playback/settings improvements.
- [Loom Media Server 1.0.35](docs/releases/v1.0.35.md): fixes the Electron Settings tab freeze and keeps the top chrome from swallowing tab clicks.
- [Loom Media Server 1.0.34](docs/releases/v1.0.34.md): keeps subtitles behind the playback overlays so controls remain readable.
- [Loom Media Server 1.0.31](docs/releases/v1.0.31.md): fixes fullscreen Back behavior and tightens fullscreen video/top-control spacing.
- [Loom Media Server 1.0.30](docs/releases/v1.0.30.md): adds item-level metadata repair, library filters, better continue watching, and anime episode rating fixes.
- [Loom Media Server 1.0.29](docs/releases/v1.0.29.md): reduces artwork cache growth and playback-time resource spikes.
- [Loom Media Server 1.0.25](docs/releases/v1.0.25.md): keeps macOS window controls while removing the full native title bar and fixing logo spacing.
- [Loom Media Server 1.0.24](docs/releases/v1.0.24.md): publishes a fresh updater release after the verified macOS restart/install fix.
- [Loom Media Server 1.0.23](docs/releases/v1.0.23.md): validates the macOS updater fallback close, replace, and relaunch flow.
- [Loom Media Server 1.0.22](docs/releases/v1.0.22.md): adds a macOS updater fallback for ad-hoc signed builds.
- [Loom Media Server 1.0.21](docs/releases/v1.0.21.md): verifies packaged update restart from 1.0.20 without blank-window regressions.
- [Loom Media Server 1.0.20](docs/releases/v1.0.20.md): fixes packaged updater startup dependencies and trims safe unused code.
- [Loom Media Server 1.0.19](docs/releases/v1.0.19.md): fixes restart-to-update reliability and polishes update/settings UI feedback.
- [Loom Media Server 1.0.17](docs/releases/v1.0.17.md): keeps unsupported local videos inside Loom Media Server's in-app stream/transcode player.
- [Loom Media Server 1.0.16](docs/releases/v1.0.16.md): fixes episode metadata title matching for series playback.
- [Loom Media Server 1.0.15](docs/releases/v1.0.15.md): improves local playback, series handoff behavior, subtitle controls, and update feedback.
- [Loom Media Server 1.0.13](docs/releases/v1.0.13.md): fixes macOS relaunch/focus behavior when Loom Media Server is already running.
- [Loom Media Server 1.0.12](docs/releases/v1.0.12.md): fixes release CI signing fallbacks and Linux package metadata.
- [Loom Media Server 1.0.11](docs/releases/v1.0.11.md): improves GitHub-hosted update flow, release packaging, and restart prompts.
- [Loom Media Server 1.0.10](docs/releases/v1.0.10.md): fixes auto-update detection/install flow for packaged apps using GitHub-hosted releases.
- [Loom Media Server 1.0.8](docs/releases/v1.0.8.md): fixes installed macOS builds so adding library folders no longer crashes on the packaged SQLite native module.
- [Loom Media Server 1.0.7](docs/releases/v1.0.7.md): fixes library folder updates so scans no longer overwrite saved library data mid-progress, and clarifies update installation restart state.
- [Loom Media Server 1.0.6](docs/releases/v1.0.6.md): adds the new theming system, black/default/navy themes, an Others library section, and several playback, metadata, and settings UX fixes.
- [Loom Media Server 1.0.5](docs/releases/v1.0.5.md): fixes installed-app library add and sync stalls by keeping library payloads lightweight and moving artwork caching out of the blocking scan path.

## Tech Stack

- Electron Forge for the development desktop shell.
- Electron Builder for release packaging and GitHub-hosted auto-update metadata.
- Vite for main, preload, and renderer builds.
- React 19 and React Router for the renderer UI.
- TypeScript for application code.
- Tailwind CSS and local UI components for styling.
- better-sqlite3 for local persistence.
- FFmpeg, FFprobe, and HLS.js for direct playback checks and HLS/transcode fallback.

## Playback Roadmap

- Short term: keep playback inside Loom Media Server by using browser-compatible streams and HLS/transcode fallbacks so custom React controls can stay over the video.
- Long term: add dedicated native playback only if the in-app HTML5/HLS path cannot cover a real user workflow.

## Getting Started

### Prerequisites

- Node.js and pnpm.
- macOS, Windows, or Linux desktop environment supported by Electron.
- Optional: TMDB and OMDb API keys for richer metadata results.

### Clone and Install

```sh
git clone https://github.com/mallenkb/LoomTV.git
cd LoomTV
corepack pnpm install
```

If you already have the source code, install dependencies from the project root:

```sh
corepack pnpm install
```

### Run in Development

```sh
corepack pnpm start
```

The app opens as an Electron desktop application. Add media folders from Settings, then run a scan to populate the library.

## Build From Source

Local development is powered by Electron Forge. Release builds are generated by Electron Builder so GitHub releases include the update metadata files that `electron-updater` expects.

### Package Locally

```sh
corepack pnpm run package
```

This creates an unpacked local app build under `out/`.

### Create Installers or Archives

```sh
corepack pnpm run dist
```

This creates platform-specific distributables under `out/builder/`.

Configured makers include:

- macOS: DMG and ZIP archive, including `latest-mac.yml` update metadata.
- Windows: NSIS installer, including `latest.yml` update metadata.
- Linux: AppImage, DEB, and RPM packages. AppImage builds can participate in the updater flow.

### Publish

```sh
corepack pnpm run publish
```

Publishes distributables through Electron Builder's GitHub publisher. Publishing requires `GH_TOKEN` or `GITHUB_TOKEN` with release permissions.

For release automation:

1. Bump version with `pnpm version 1.0.12` (or the next patch/minor version).
2. Push commit and create/push a tag that matches `v*`:

   ```sh
   git push origin main
   git push origin v1.0.12
   ```

3. The workflow in `.github/workflows/build-installers.yml` runs on tag pushes. Electron Builder creates and uploads macOS/Windows/Linux installers plus updater metadata (`latest*.yml`, `.blockmap`) to the GitHub release.

### Auto-update behavior

- `electron-updater` checks once at startup (when packaged) and every 6 hours in the background.
- You can also use **Check for Updates…** from the app menu or the Settings update card.
- While an update downloads, Loom Media Server shows a small, quiet update affordance instead of interrupting playback or browsing.
- After a package is downloaded, Loom Media Server prompts to restart now. If you skip, the update remains ready in-app until installed later.

- Requirements:
  - GitHub releases must be published with version tags like `v1.0.12`.
  - Release assets must include install artifacts and Electron Builder update metadata files (workflow is configured for this).
  - macOS/Windows release builds should be signed in CI for reliable install/update trust.
  - mac signing: configure Electron Builder signing secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`; notarization also needs Apple credentials such as `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
  - Windows signing: configure Electron Builder signing secrets such as `CSC_LINK` and `CSC_KEY_PASSWORD`.

### macOS external distribution

For a public download site, macOS releases must use a **Developer ID Application** certificate and Apple notarization. The desktop release workflow already passes the required credentials to Electron Builder and will notarize tagged macOS releases when these GitHub Actions secrets are present:

- `MACOS_CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `MACOS_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The current Apple Developer account cannot create Developer ID certificates because that action is restricted to the Account Holder. Mac App Distribution certificates are not a substitute for external-site distribution; they are for the Mac App Store.

Until a Developer ID certificate is available, a limited ad-hoc archive can be produced on macOS with:

```sh
corepack pnpm --filter loom-media-server-desktop dist:adhoc
```

Ad-hoc builds are not notarized, are not suitable as a normal public release, and require users to approve the first launch manually.

## Metadata Setup

Loom Media Server can enrich local files with artwork and metadata. Open Settings, then add provider keys under "Metadata API Keys".

- TMDB is recommended for movie and TV posters, backdrops, cast info, ratings, and summaries.
- OMDb is available as an optional fallback provider.
- TVmaze and Jikan/MyAnimeList are used for TV and anime metadata flows where available.

## Scripts

- `corepack pnpm desktop:start`: start the Electron Forge desktop app.
- `corepack pnpm mobile:start`: start the Expo mobile app.
- `corepack pnpm --filter loom-media-server-desktop package`: create an unpacked local desktop build.
- `corepack pnpm --filter loom-media-server-desktop make`: create Electron Forge desktop distributables.
- `corepack pnpm --filter loom-media-server-desktop dist`: create Electron Builder release artifacts without publishing.
- `corepack pnpm typecheck`: run TypeScript checks for workspace packages.
- `corepack pnpm test`: run workspace tests.

## Project Structure

```text
apps/
  desktop/
    src/         Electron main process, renderer UI, database, playback, probing, and transcode code.
    resources/   Bundled FFmpeg and FFprobe resources and notices.
    tests/       Desktop unit tests.
  mobile/        Expo React Native MVP client for pairing with a desktop host and testing playback.
```

## Building and Packaging

The Forge configuration packages the desktop app with ASAR enabled and includes media tooling resources from `apps/desktop/resources/ffmpeg`. Platform makers are configured for ZIP on macOS, Squirrel on Windows, and DEB/RPM on Linux.

## Third-Party Notices

Loom Media Server depends on open-source desktop, UI, database, and media libraries. Important runtime dependencies include Electron, Electron Forge, React, React Router, Vite, TypeScript, Tailwind CSS, better-sqlite3, HLS.js, Motion, Lucide React, ffmpeg-static, and ffprobe-static.

The application also includes local UI component patterns inspired by shadcn/ui.

### FFmpeg and FFprobe

Loom Media Server bundles FFmpeg and FFprobe command line tools so users do not need to install FFmpeg separately.

- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
- Loom Media Server is not affiliated with the FFmpeg project.
- Bundled FFmpeg builds may include GPL components and are distributed under the GNU General Public License version 3 or later, as applicable to those builds and their included libraries.
- Loom Media Server invokes FFmpeg as separate command line executables. The FFmpeg binaries remain third-party software owned by their respective copyright holders.

See `apps/desktop/resources/ffmpeg/NOTICE.md` for bundled build details, source references, and download URLs. See `apps/desktop/resources/ffmpeg/COPYING.GPLv3.txt` for the GPLv3 license text.

### Metadata Providers

Loom Media Server may use third-party metadata providers to retrieve artwork, summaries, ratings, and related media information.

- TMDB: movie and TV posters, backdrops, cast data, ratings, and metadata.
- TVmaze: TV show and episode metadata.
- Jikan / MyAnimeList: anime posters, ratings, and anime metadata.
- OMDb API: fallback movie and TV metadata.

Loom Media Server is not affiliated with, endorsed by, or sponsored by these providers. Use of provider data and API keys is subject to each provider's own terms, attribution rules, rate limits, and privacy policies.

## Disclaimers

- Loom Media Server is a local media manager and player. It does not provide, host, sell, stream, or download copyrighted movies, TV shows, anime, subtitles, or other media.
- You are responsible for ensuring that the media files, subtitles, metadata, and artwork you use with Loom Media Server are lawful for you to access and use.
- API keys are your responsibility. Keep provider keys private and follow the terms of the providers you connect.
- Local playback, transcoding, and metadata matching can vary by file format, codec, operating system, and bundled or system media tools.
- This software is provided as-is, without warranty of any kind.

## License and Copyright

Copyright (c) 2026 malllenkb

Loom Media Server source code is licensed under the MIT License. See `LICENSE` for the full license text.

```text
MIT License

Copyright (c) 2026 malllenkb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Bundled third-party tools and dependencies remain under their own licenses. In particular, bundled FFmpeg/FFprobe builds are covered by their applicable FFmpeg and GPL notices as described above.
