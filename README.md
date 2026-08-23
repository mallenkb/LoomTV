# LoomTV

LoomTV is a private, self-hosted video library for browsing and playing movies, TV shows, anime, and other video files. One canonical server, API, account system, and SQLite store power desktop-hosted, headless/NAS, browser, mobile, and Android TV/Fire TV clients.

This project is for organizing and playing media files that you own, have created, or are otherwise authorized to use. LoomTV does not provide movies, TV shows, anime, streaming subscriptions, or copyrighted media.

> **On naming.** The shipped product is **LoomTV**: that is
> `productName` in `apps/desktop/package.json`, the installer and application
> name, and the name `scripts/release-identity.cjs` enforces on every release.
> "Loom Media Server" appears throughout this document and in the workspace
> package names (`loom-media-server-desktop`, `loom-media-server-headless`) as
> the older internal name. The two refer to the same product. The package
> identifiers remain unchanged for now to keep this release-truth cleanup
> separate from a repository-wide naming migration.

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
- Run the same canonical server inside the desktop app or independently on a NAS.
- Use scoped household accounts, multiple administrators, profiles, PINs, device pairing, and private invitations.
- Download video for offline mobile or browser use and hand browser playback to supported AirPlay or Remote Playback receivers.
- Browse and play from the hosted web, iOS/Android mobile, and Android TV/Fire TV clients.

## Headless and NAS deployment

The repository now includes a GUI-independent headless server for NAS and
always-on hosts. It provides runtime health, mounted-root status, a persistent
catalog scanner that preserves records when a share is offline, authenticated
direct media delivery, on-demand HLS transcoding, a browser control surface,
and Docker/systemd deployment scaffolding. Accounts, profiles, selections,
lists, progress, devices, invitations, downloads, and playback sessions all use
the canonical server state.

- Start the health/admin boundary with `pnpm server:start`.
- Open `/healthz` or `/admin/` on the configured server address.
- Follow the [NAS deployment guide](docs/nas-deployment.md) for Docker Compose,
  systemd, mounted SMB/NFS shares, backups, permissions, and hardware access.
- See the [video feature status](docs/loomtv-vs-jellyfin-feature-status.md) for
  implemented behavior, verification evidence, and remaining platform checks.
- Generate thumbnails and inspect local media details with bundled FFmpeg/FFprobe resources.
- Customize artwork, theme color, loader style, and sidebar ordering.
- Back up the local database from Settings.

## Download

Prebuilt desktop releases, when available, are published from the repository releases page:

https://github.com/mallenkb/LoomTV/releases

Download the installer or archive for your operating system, then run it like any other desktop app. If no release is available for your platform, build the app locally from source using the instructions below.

## Release Notes

- [LoomTV 1.0.129](docs/releases/v1.0.129.md): improves responsive browser layouts and detail-page transitions, and fixes Windows native playback, profile gating, and remote browser fallback behavior.
- [LoomTV 1.0.128](docs/releases/v1.0.128.md): improves desktop playback controls, artwork badges, hero actions, plugin discovery, and theme customization.
- [LoomTV 1.0.127](docs/releases/v1.0.127.md): improves desktop LAN discovery, playback progress, artwork and ratings, theme controls, and companion mobile reliability.
- [LoomTV 1.0.126](docs/releases/v1.0.126.md): restores trusted CI validation for the mobile release gate and refreshes the verified desktop packages.
- [LoomTV 1.0.125](docs/releases/v1.0.125.md): fixes browser-host detection and artwork API routing, improves custom-folder navigation state, and refines desktop artwork presentation.
- [LoomTV 1.0.124](docs/releases/v1.0.124.md): makes desktop packaging resilient to transient dependency-download failures and retains the longer multi-platform publishing window.
- [LoomTV 1.0.123](docs/releases/v1.0.123.md): refreshes every desktop package and gives the multi-platform publisher enough time to upload the complete release safely.
- [LoomTV 1.0.122](docs/releases/v1.0.122.md): adds custom media libraries, improves responsive artwork selection and desktop browsing, and fixes Windows native-module release packaging.
- [LoomTV 1.0.120](docs/releases/v1.0.120.md): improves desktop metadata refresh, provider artwork and ratings persistence, detail information, and series-folder reconciliation.
- [LoomTV 1.0.89](docs/releases/v1.0.89.md): fixes real-time audio and subtitle switching so selected tracks remain active during stream replacement.
- [LoomTV 1.0.88](docs/releases/v1.0.88.md): speeds up desktop startup, improves tray packaging, and strengthens shared LAN support across desktop and mobile.
- [LoomTV 1.0.87](docs/releases/v1.0.87.md): improves next-episode playback from preview skip prompts.
- [LoomTV 1.0.86](docs/releases/v1.0.86.md): fixes the actual cause of the desktop hero positioning bug — a minifier quirk that dropped the transform reset.
- [LoomTV 1.0.85](docs/releases/v1.0.85.md): fixes the remaining Electron hero translation and restores full-width desktop artwork.
- [LoomTV 1.0.84](docs/releases/v1.0.84.md): fixes the desktop Modern detail hero while preserving the working web layout.
- [LoomTV 1.0.83](docs/releases/v1.0.83.md): fixes the continue-watching thumbnail overlay and macOS settings-tab interaction.
- [LoomTV 1.0.82](docs/releases/v1.0.82.md): fixes the continue-watching thumbnail overlay so artwork stays clear.
- [LoomTV 1.0.81](docs/releases/v1.0.81.md): improves targeted artwork repair, metadata selection, and desktop detail views.
- [LoomTV 1.0.80](docs/releases/v1.0.80.md): improves artwork repair, playback preferences, update progress, and player styling.
- [LoomTV 1.0.79](docs/releases/v1.0.79.md): publishes the complete desktop installer set with the corrected updater packaging.
- [LoomTV 1.0.78](docs/releases/v1.0.78.md): fixes macOS packaging with the patched Electron updater runtime.
- [LoomTV 1.0.77](docs/releases/v1.0.77.md): republishes the desktop release with corrected dependency auditing and updater runtime security.
- [LoomTV 1.0.76](docs/releases/v1.0.76.md): republishes the desktop discovery and Modern experience with corrected pnpm release CI.
- [LoomTV 1.0.75](docs/releases/v1.0.75.md): refreshes desktop discovery, pairing, profiles, artwork, and the Modern viewing experience.
- [LoomTV 1.0.74](docs/releases/v1.0.74.md): fixes saved audio and subtitle track preferences during fast playback changes.
- [LoomTV 1.0.73](docs/releases/v1.0.73.md): improves modern desktop panel shadows for consistent dark-mode contrast.
- [LoomTV 1.0.72](docs/releases/v1.0.72.md): republishes the modern desktop experience with desktop-scoped dependency auditing in release CI.
- [LoomTV 1.0.71](docs/releases/v1.0.71.md): adds a cinematic modern desktop experience, refreshed navigation and search, and cleaner update controls.
- [LoomTV 1.0.70](docs/releases/v1.0.70.md): fixes missing macOS updater metadata and hardens packaged update checks.
- [LoomTV 1.0.69](docs/releases/v1.0.69.md): improves folder-aware navigation and makes desktop update progress clearer.
- [LoomTV 1.0.67](docs/releases/v1.0.67.md): improves desktop remote profile sync, onboarding, playback recovery, and Continue Watching behavior.
- [LoomTV 1.0.66](docs/releases/v1.0.66.md): adds secure paired remote-library access, resilient session restoration, and safer remote media playback.
- [LoomTV 1.0.65](docs/releases/v1.0.65.md): adds mobile profile switching, PIN unlock, profile-aware settings, improved pairing, and mobile playback polish.
- [LoomTV 1.0.64](docs/releases/v1.0.64.md): adds faster profile switching, unified My List controls, and more reliable profile-aware LAN browser access.
- [LoomTV 1.0.63](docs/releases/v1.0.63.md): adds desktop host-or-remote onboarding, paired remote-library playback, and distinct Outro, Credits, and Preview skip markers.
- [LoomTV 1.0.61](docs/releases/v1.0.61.md): publishes the complete desktop profile release with cross-platform Settings verification normalized for Windows line endings.
- [LoomTV 1.0.60](docs/releases/v1.0.60.md): republishes the complete desktop profile, Kids restrictions, personal lists, profile transfer, and LAN security release with current Settings source-verification tests.
- [LoomTV 1.0.59](docs/releases/v1.0.59.md): completes desktop profiles with PIN workflows, Kids restrictions, per-profile lists and settings, profile transfer, LAN enforcement, metadata ratings, and detailed security and migration improvements.
- [LoomTV 1.0.58](docs/releases/v1.0.58.md): aligns profile migration verification with the current schema ledger and republishes the corrected desktop profile release.
- [LoomTV 1.0.57](docs/releases/v1.0.57.md): fixes profile-service type contracts so the new desktop profile release builds successfully on every supported platform.
- [LoomTV 1.0.56](docs/releases/v1.0.56.md): adds desktop viewer profiles with profile-specific progress, PIN protection, profile switching, and safer playback handoff behavior.
- [LoomTV 1.0.55](docs/releases/v1.0.55.md): keeps desktop installer validation scoped to the desktop app so mobile-only failures cannot block desktop releases.
- [LoomTV 1.0.54](docs/releases/v1.0.54.md): aligns desktop theme verification with the neutral light and dark palettes used by the app.
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
- A bundled LibVLC/Koffi bridge for local desktop playback, with the established mpv and Chromium/HLS fallbacks.

## Playback Architecture

- The desktop application starts the canonical server and opens its hosted `/app/` client in a sandboxed Electron window. It does not run a second desktop catalog or account authority.
- Every client requests a canonical playback plan. Compatible files receive a short-lived, media/profile-bound direct capability. Other files use an authenticated HLS session backed by FFmpeg.
- Mobile and TV clients pin the server certificate and route requests through the native streaming transport. Browser, casting, and external subtitle capabilities remain bounded and revocable.
- Legacy LibVLC, mpv, renderer, and v2 compatibility code remains in the repository for migration and rollback work, but it is not the canonical packaged desktop entry point.
- Local desktop files preserve the classic Loom player composition. On macOS and Windows they play through the LibVLC in-window native surface when a runtime is available, then packaged or user/system-installed mpv, then the browser/HLS path. Set `LOOMTV_LIBVLC_COMPOSITED_SURFACE=0` to force the mpv/browser fallback for a launch.
- LAN, remote, and mobile playback continue through LoomTV's authenticated direct-play/transcode and browser/HLS paths.

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

Both commands live in the `loom-media-server-desktop` workspace, not at the
repository root. Run them through the workspace filter.

### Package Locally

```sh
corepack pnpm --filter loom-media-server-desktop run package
```

This creates an unpacked local app build under `apps/desktop/out/`.

### Create Installers or Archives

```sh
corepack pnpm --filter loom-media-server-desktop run dist
```

This runs `electron-builder --publish=never` and writes platform-specific
distributables under `apps/desktop/out/builder/`.

Electron Builder targets (`apps/desktop/package.json` `build`):

- macOS: DMG and ZIP for `arm64` and `x64`, including `latest-mac.yml` update metadata.
- Windows: NSIS installer for `x64`, including `latest.yml` update metadata.
- Linux: AppImage, DEB, and RPM packages. AppImage builds can participate in the updater flow.

Electron Forge makers (`apps/desktop/forge.config.ts`) are a separate local-only
set and do not produce release artifacts: ZIP on all three platforms, DMG on
macOS, plus Squirrel, RPM, and DEB when their platform toolchains are present.

### Publish

There is no `publish` script in this repository, and no local command publishes a
release. `dist` always passes `--publish=never`, so Electron Builder's GitHub
publisher is never invoked. Releases are published only by
`.github/workflows/release.yml`, which uploads artifacts with the `gh` CLI after
verifying tag identity, checksums, and build attestations.

For release automation:

1. Bump the desktop version, which is the version the release gate checks.
   `X.Y.Z` below is a placeholder for the version you are releasing:

   ```sh
   corepack pnpm --filter loom-media-server-desktop version X.Y.Z --no-git-tag-version
   ```

   `scripts/release-identity.cjs` requires `apps/desktop/package.json` to match
   the tag exactly. The root manifest is private and carries no version, so
   `pnpm version` at the root does not set the release version.
2. Write the release notes the gate requires at `docs/releases/vX.Y.Z.md`.
   `scripts/release-identity.cjs` fails a release whose notes file is missing,
   empty, or a symlink.
3. Commit the version, lockfile, and release notes. Push that commit to `main`.
4. Create and push an annotated tag matching
   `vMAJOR.MINOR.PATCH`. Prerelease and build-metadata tags are rejected,
   because there is only one updater channel:

   ```sh
   git tag -a vX.Y.Z -m 'LoomTV X.Y.Z'
   git push origin vX.Y.Z
   ```

5. The release workflow in `.github/workflows/release.yml` runs on version-tag pushes or a manual dispatch gated by the protected `production-release` environment. It creates macOS/Windows/Linux installers with Electron Builder and uploads them with updater metadata (`latest*.yml`, `.blockmap`) to the GitHub release. Pull-request events and `main`-branch pushes run only `.github/workflows/validate.yml`, which has a read-only token and no signing or publishing secrets.

### Auto-update behavior

- `electron-updater` checks once at startup (when packaged) and every 6 hours in the background.
- You can also use **Check for Updates…** from the app menu or the Settings update card.
- While an update downloads, Loom Media Server shows a small, quiet update affordance instead of interrupting playback or browsing.
- After a package is downloaded, Loom Media Server prompts to restart now. If you skip, the update remains ready in-app until installed later.

- Requirements:
  - GitHub releases must be published with stable `vX.Y.Z` tags.
  - Release assets must include install artifacts and Electron Builder update metadata files (workflow is configured for this).
  - Signing is credential-gated, not mandatory. The release workflow reads
    platform-specific secrets and maps them onto `CSC_LINK` and
    `CSC_KEY_PASSWORD` itself; do not set the generic names as repository
    secrets.
  - macOS signing: `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`,
    `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Supplying
    `MACOS_CSC_LINK` without all four companions fails the build rather than
    producing a partly signed artifact.
  - Windows signing: `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, and
    `WINDOWS_SIGNER_THUMBPRINT`, with the same all-or-nothing rule.
  - When the platform certificate secret is absent the workflow still produces a
    release: macOS falls back to the existing ad-hoc signer and Windows produces
    an unsigned installer. The post-build signature and notarization checks are
    skipped in that case, so an unsigned release is possible and will show OS
    trust prompts on install and update.
  - Linux builds never sign; `CSC_IDENTITY_AUTO_DISCOVERY` is forced off.

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
    src/main.ts  Electron main-process entrypoint (app lifecycle, windows, IPC wiring).
    src/main/    Main-process modules: database, playback, probing, transcode, LAN.
    src/         Renderer UI (React) and shared renderer libraries.
    resources/   Bundled FFmpeg, FFprobe, and staged native playback resources and notices.
    tests/       Desktop unit tests.
  server/        Headless server runtime: /api/v1, admin service, library scanner,
                 transcoder, and the browser client at /app/.
  mobile/        Expo React Native iOS/Android client.
packages/
  video-contracts/        Canonical API, identity, account, profile, and playback contracts.
  media-core/             Shared media identity, classification, and playback-plan helpers.
  runtime-paths/          Data, cache, and media directory resolution shared by both runtimes.
  transcode-capabilities/ Client capability and transcode-decision helpers.
  lan-protocol/           Desktop/mobile LAN pairing and transport types.
  plugin-protocol/        Stremio-style plugin protocol and sandbox types.
deploy/
  docker/        Dockerfile, compose file, and entrypoint for the headless server.
  systemd/       Unit and environment example for a Linux service install.
scripts/         Release-identity, evidence, workflow-policy, and audit tooling.
docs/            Product, deployment, release, and status documentation.
```

The desktop and NAS/container deployments use the same canonical server in
`apps/server`. The packaged desktop entry performs the one-time legacy migration
before startup and does not open a second catalog or account authority. See the
[canonical migration guide](docs/canonical-migration.md) and
[video feature status](docs/loomtv-vs-jellyfin-feature-status.md).

## Building and Packaging

The Forge configuration packages the desktop app with ASAR enabled and includes media tooling resources from `apps/desktop/resources/ffmpeg`, plus staged native playback payloads under `apps/desktop/resources/libvlc` and `apps/desktop/resources/mpv`. The supported Windows x64 and macOS targets carry their verified LibVLC payloads outside `app.asar`. Platform makers are configured for ZIP on macOS, Squirrel on Windows, and DEB/RPM on Linux.

## Third-Party Notices

Loom Media Server depends on open-source desktop, UI, database, and media libraries. Important runtime dependencies include Electron, Electron Forge, React, React Router, Vite, TypeScript, Tailwind CSS, better-sqlite3, HLS.js, Motion, Lucide React, and Koffi. Release payloads include staged native LibVLC and MPV artifacts for the supported targets; Windows and macOS LibVLC surfaces preserve Loom's single-window renderer composition. Unsupported or development targets continue to use compatible system runtimes and browser/HLS fallback where available. LoomTV does not download native runtimes at application runtime.

The application also includes local UI component patterns inspired by shadcn/ui.

### FFmpeg and FFprobe

Loom Media Server bundles FFmpeg and FFprobe command line tools so users do not need to install FFmpeg separately.

- FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
- Loom Media Server is not affiliated with the FFmpeg project.
- Bundled FFmpeg builds may include GPL components and are distributed under the GNU General Public License version 3 or later, as applicable to those builds and their included libraries.
- Loom Media Server invokes FFmpeg as separate command line executables. The FFmpeg binaries remain third-party software owned by their respective copyright holders.

See `apps/desktop/resources/ffmpeg/NOTICE.md` for bundled build details, source references, and download URLs. See `apps/desktop/resources/ffmpeg/COPYING.GPLv3.txt` for the GPLv3 license text.

### LibVLC / VLC media engine

LibVLC and libvlccore are generally distributed under LGPL-2.1-or-later, but
VLC plugin modules and bundled dependencies can carry different terms. The
exact staged payload provenance, checksums, and applicable notice requirements
are recorded in `apps/desktop/resources/libvlc/NOTICE.md`. See the
[VideoLAN legal notices](https://www.videolan.org/legal.html) for upstream
licensing information.

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
- [LoomTV 1.0.111](docs/releases/v1.0.111.md): keeps the display awake during active native playback and releases the blocker reliably when playback stops.
- [LoomTV 1.0.113](docs/releases/v1.0.113.md): refreshes desktop browsing, metadata, playback, library, and profile experiences.
- [LoomTV 1.0.114](docs/releases/v1.0.114.md): restores the desktop release fallback when platform signing credentials are not configured, while preserving signed builds when credentials are available.
- [LoomTV 1.0.115](docs/releases/v1.0.115.md): fixes release attestation inputs and Linux artifact naming for the desktop installers.
- [LoomTV 1.0.116](docs/releases/v1.0.116.md): restores automatic desktop updates with a complete, attested multi-platform release.
- [LoomTV 1.0.117](docs/releases/v1.0.117.md): fixes desktop release artifact filtering and refreshes the Discover page header layout.
- [LoomTV 1.0.118](docs/releases/v1.0.118.md): aligns updater evidence with the desktop installers published by electron-builder.
- [LoomTV 1.0.112](docs/releases/v1.0.112.md): refines desktop Discover browsing and enhances anime cast display.
- [LoomTV 1.0.110](docs/releases/v1.0.110.md): improves macOS MPV compatibility and avoids unnecessary fallback-runtime checks during playback.
- [LoomTV 1.0.109](docs/releases/v1.0.109.md): replaces raw updater filesystem errors with concise, actionable status messages.
- [LoomTV 1.0.108](docs/releases/v1.0.108.md): hardens macOS update signing compatibility and clears the production audit gate.
- [LoomTV 1.0.107](docs/releases/v1.0.107.md): speeds up library-refresh feedback with a dedicated desktop scan spinner.
- [LoomTV 1.0.106](docs/releases/v1.0.106.md): makes library refresh activity visible in the sidebar.
- [LoomTV 1.0.105](docs/releases/v1.0.105.md): bundles native playback runtimes, improves desktop playback and memory behavior, and refreshes mobile/server release configuration.
- [LoomTV 1.0.104](docs/releases/v1.0.104.md): fixes Home personal-list placement and hardens desktop release asset publishing.
- [LoomTV 1.0.103](docs/releases/v1.0.103.md): completes mixed-video library handling, expands the mobile companion, and adds release-configuration safeguards.
- [LoomTV 1.0.102](docs/releases/v1.0.102.md): adds the headless NAS server foundation, shared media/transcoding capabilities, and reliable multi-platform release publishing.
- [LoomTV 1.0.101](docs/releases/v1.0.101.md): fixes mobile test module resolution and keeps secure LAN transport injection intact for releases.
- [LoomTV 1.0.100](docs/releases/v1.0.100.md): hardens desktop trust boundaries and refreshes responsive Modern layout, accessibility, and CI safeguards.
- [LoomTV 1.0.99](docs/releases/v1.0.99.md): fixes library-page spacing and aligns the playback bar and custom-folder pages with Modern Home.
- [LoomTV 1.0.98](docs/releases/v1.0.98.md): aligns custom folders with the modern library navigation and filtering experience.
- [LoomTV 1.0.97](docs/releases/v1.0.97.md): adds library health filters and refines desktop search and detail navigation.
- [LoomTV 1.0.96](docs/releases/v1.0.96.md): refines modern sidebar and Settings navigation hover and active states.
- [LoomTV 1.0.95](docs/releases/v1.0.95.md): keeps active navigation and Settings tabs fixed without fluid hover highlights.
- [LoomTV 1.0.94](docs/releases/v1.0.94.md): refines hero actions with a solid play icon and a clean View details button.
- [LoomTV 1.0.93](docs/releases/v1.0.93.md): improves desktop library performance, playback navigation, LAN behavior, and update cleanup.
- [LoomTV 1.0.92](docs/releases/v1.0.92.md): adds the hardened MPV playback path and memory-focused desktop improvements.
