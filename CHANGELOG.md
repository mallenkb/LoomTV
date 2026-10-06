# Release notes

This page is the release index for LoomTV. Each version links to its full notes. Installers and archives are published on [GitHub Releases](https://github.com/mallenkb/LoomTV/releases).

## Recent releases

### [2.0.16](docs/releases/v2.0.16.md)

Adds the compact next-episode calendar card with clearer month labels, episode codes, a larger countdown, and tighter spacing.

### [2.0.15](docs/releases/v2.0.15.md)

Republishes the Electron desktop app with a shell-quote dependency fix required by the production audit.

### [2.0.14](docs/releases/v2.0.14.md) (not published)

Prepared a desktop republication, but the dependency audit blocked publication.

### [2.0.13](docs/releases/v2.0.13.md)

Adds Cinemeta defaults and live IMDb ratings, English TheTVDB metadata, smaller artwork controls, rewind on resume, import-specific organization, and dependency fixes.

### [2.0.12](docs/releases/v2.0.12.md) (not published)

Includes the metadata, playback, and library improvements prepared for 2.0.11, with dependency fixes required to pass the release audit.

### [2.0.11](docs/releases/v2.0.11.md) (not published)

Adds Cinemeta defaults and live IMDb ratings, English TheTVDB metadata, smaller artwork controls, rewind on resume, and import-specific organization and recovery improvements.

### [2.0.10](docs/releases/v2.0.10.md)

Moves artwork decoding, media probing, and LibVLC teardown off the desktop main thread, adds startup code caches, and protects file organization while downloads are unfinished.

### [2.0.9](docs/releases/v2.0.9.md)

Adds recoverable library organization and cleanup, reduces desktop playback memory use, and integrates the first local photo, audio, and reading-library implementations.

### [2.0.8](docs/releases/v2.0.8.md)

Improves online subtitle matching when IMDb IDs are missing, fixes series metadata years and media organization safeguards, and patches a node-forge signature verification issue.

### [2.0.7](docs/releases/v2.0.7.md)

Corrects season-aware episode naming and loose-file organization, prioritizes new badges across library categories, and puts completed titles last.

### [2.0.6](docs/releases/v2.0.6.md)

Improves TV invitation playback, native streaming reliability, mobile download cleanup, PIN recovery, and parental rating filters.

### [2.0.5](docs/releases/v2.0.5.md)

Fixes TV server discovery and hosted web playback progress, hardens server request handling, and corrects the image-size security waiver.

### [2.0.4](docs/releases/v2.0.4.md)

Adds Intel Mac runtime support, fetches pinned native runtimes during builds, and restores automated tests and release-gate checks.

### [2.0.3](docs/releases/v2.0.3.md)

Limits Continue Watching to five recent titles and removes completed items.

### [2.0.2](docs/releases/v2.0.2.md)

Adds a subtitle shortcut, avoids a redundant LibVLC subtitle toggle, and updates the workspace to pnpm 12.6.0.

### [2.0.1](docs/releases/v2.0.1.md)

Improves sidebar progress indicators and retries automatic file organization after files settle or the app restarts.

### [2.0.0](docs/releases/v2.0.0.md)

Marks the 2.0.0 major-version checkpoint. No app-code changes since 1.0.203.

### [1.0.203](docs/releases/v1.0.203.md)

Adds new-media badges and missing-episode rows, improves scan metadata and rename handling, and defaults unset file-organization preferences to automatic.

### [1.0.202](docs/releases/v1.0.202.md)

Redirects stale local detail pages to the right library section and reduces delayed tooltip text size.

### [1.0.201](docs/releases/v1.0.201.md)

Refines modern sidebar category labels and improves the compact profile switcher's accessible name and tooltip behavior.

### [1.0.200](docs/releases/v1.0.200.md)

Matches sidebar update and refresh controls to the profile avatar size and adds a smooth theme-aware update hover.

### [1.0.199](docs/releases/v1.0.199.md)

Republishes the Electron desktop app as v1.0.199, with no app-code changes since v1.0.198.

### [1.0.198](docs/releases/v1.0.198.md)

Adds new-title and episode badges across desktop library pages, shares episode updates, and replaces native sidebar titles with delayed tooltips.

### [1.0.197](docs/releases/v1.0.197.md)

Adds an in-player live channel list and programme guide, and runs stream health checks only while Live TV is open.

### [1.0.196](docs/releases/v1.0.196.md)

Adds episode discovery, a library health report, live TV channel controls, and a prompt before unattended autoplay continues.

### [1.0.195](docs/releases/v1.0.195.md)

Adds optional automatic file organization after library sync, with undoable changes and protection for recently modified files.

### [1.0.194](docs/releases/v1.0.194.md)

Keeps automatic desktop update downloads in the background without an interrupting dialog.

### [1.0.193](docs/releases/v1.0.193.md)

Adds reviewed, undoable media file renaming and verifies live TV streams before listing them.

### [1.0.192](docs/releases/v1.0.192.md)

Refines desktop trackpad scrubbing and reduces query and thumbnail cache allocations.

### [1.0.191](docs/releases/v1.0.191.md)

Removes unused desktop, mobile, and server APIs and dependencies.

### [1.0.190](docs/releases/v1.0.190.md)

Adds horizontal trackpad scrubbing to desktop video playback.

### [1.0.189](docs/releases/v1.0.189.md)

Reduces desktop memory use and restores LibVLC's plugin cache for ad-hoc macOS builds.

### [1.0.188](docs/releases/v1.0.188.md)

Extends the release gate so slower validation runs can finish before publication.

### [1.0.187](docs/releases/v1.0.187.md)

Improves desktop playback reliability, artwork loading, library reconciliation, and accessibility.

### [1.0.186](docs/releases/v1.0.186.md)

Returns cache memory when idle or hidden, never during playback.

### [1.0.185](docs/releases/v1.0.185.md)

Shows the television mark while picker artwork loads.

### [1.0.184](docs/releases/v1.0.184.md)

Uses the grey television mark for fallback art and refreshes the desktop release metadata.

### [1.0.183](docs/releases/v1.0.183.md)

Restores in-app macOS automatic updates and restart for ad-hoc installations.

### [1.0.182](docs/releases/v1.0.182.md)

Adds local outro detection, an opt-in SkipDB fallback, verified-marker evidence tiers, and safer skip prompts on desktop.

### [1.0.181](docs/releases/v1.0.181.md)

Improves release gating so desktop publication waits for completed validation.

### [1.0.180](docs/releases/v1.0.180.md)

Refreshes the desktop release metadata and updater package set.

### [1.0.179](docs/releases/v1.0.179.md)

Refreshes the desktop release metadata and updater package set.

### [1.0.178](docs/releases/v1.0.178.md)

Improves desktop update handling for ad-hoc macOS installations.

### [1.0.177](docs/releases/v1.0.177.md)

Targets 4K HEVC playback memory on Apple Silicon and adds timeline previews with compact player controls.

### [1.0.176](docs/releases/v1.0.176.md)

Lowers idle memory while keeping LibVLC warm and first for local playback.

### [1.0.175](docs/releases/v1.0.175.md)

Restores the 1.0.172 playback path with LibVLC as the default local engine.

### [1.0.172](docs/releases/v1.0.172.md)

Hardens desktop updates, release verification, and large-library memory handling.

### [1.0.171](docs/releases/v1.0.171.md)

Updates Electron credential storage and migration handling.

### [1.0.170](docs/releases/v1.0.170.md)

Reduces temporary memory use while loading large Electron libraries.

### [1.0.169](docs/releases/v1.0.169.md)

Reduces memory use while validating cached artwork in the Electron desktop app.

### [1.0.168](docs/releases/v1.0.168.md)

Improves Electron playback reliability and library scanning.

### [1.0.167](docs/releases/v1.0.167.md)

Improves desktop library scanning, artwork handling, and playback.

### [1.0.166](docs/releases/v1.0.166.md)

Improves artwork selection in the desktop app.

### [1.0.165](docs/releases/v1.0.165.md)

Updates the desktop updater experience and validation workflow.

### [1.0.164](docs/releases/v1.0.164.md)

Updates the desktop library experience and playback behavior.

### [1.0.163](docs/releases/v1.0.163.md)

Keeps initial library setup focused on the default video categories and tidies the metadata source list.

### [1.0.162](docs/releases/v1.0.162.md)

Improves release reliability.

### [1.0.161](docs/releases/v1.0.161.md)

Fixes the episode panel's sticky season header clipping over episode rows.

### [1.0.160](docs/releases/v1.0.160.md)

Includes the desktop provider and player-control updates with a server playback fix.

### [1.0.159](docs/releases/v1.0.159.md)

Adds automatic Cinemeta setup for desktop users and refines the player controls.

### [1.0.158](docs/releases/v1.0.158.md)

Improves desktop update handling while media is playing.

### [1.0.157](docs/releases/v1.0.157.md)

Maintenance release containing the latest validated desktop build.

### [1.0.156](docs/releases/v1.0.156.md)

Maintenance release containing the latest validated desktop build.

### [1.0.155](docs/releases/v1.0.155.md)

Improves release reliability and updates a production dependency to its patched version.

### [1.0.154](docs/releases/v1.0.154.md)

Cleans up repository-only audit artifacts without changing the desktop app experience.

### [1.0.153](docs/releases/v1.0.153.md)

Fixes lint errors in the Electron subtitle flow.

### [1.0.152](docs/releases/v1.0.152.md)

Removes the legacy OpenSubtitles API-key setup from the Electron desktop app.

### [1.0.151](docs/releases/v1.0.151.md)

Updates the Electron desktop app and fixes macOS runtime verification for the bundled libmpv player.

### [1.0.150](docs/releases/v1.0.150.md)

Updates the Electron desktop app with the latest playback, subtitle, settings, and application-structure changes from `main`.

### [1.0.149](docs/releases/v1.0.149.md)

Updates the Electron desktop playback stack.

### [1.0.148](docs/releases/v1.0.148.md)

Ships the latest Electron desktop playback and player-control updates.

### [1.0.147](docs/releases/v1.0.147.md)

Improves playback diagnostics, download reliability, and cross-client progress handling.

### [1.0.146](docs/releases/v1.0.146.md)

Desktop maintenance release based on the latest validated main branch.

### [1.0.145](docs/releases/v1.0.145.md)

Improves playback reliability and keeps library, server, and client behavior aligned across the supported apps.

### [1.0.144](docs/releases/v1.0.144.md)

Desktop maintenance release based on the latest validated build.

### [1.0.143](docs/releases/v1.0.143.md)

Improves desktop artwork, metadata, theming, and playback presentation.

### [1.0.142](docs/releases/v1.0.142.md)

Improves desktop artwork selection, playback, metadata, and Live TV support.

### [1.0.141](docs/releases/v1.0.141.md)

Improves startup readiness, Live TV source management, and desktop metadata loading.

### [1.0.140](docs/releases/v1.0.140.md)

Bundles the latest navigation, playback, metadata, and responsive layout updates.

### [1.0.139](docs/releases/v1.0.139.md)

Updates the Live TV sidebar icon states.

### [1.0.138](docs/releases/v1.0.138.md)

Preserves playlist order for Live TV channels unless a sort is selected.

### [1.0.137](docs/releases/v1.0.137.md)

Fixes desktop validation issues from the Live TV source icon update.

### [1.0.136](docs/releases/v1.0.136.md)

Improves desktop Live TV setup and production startup safety.

### [1.0.135](docs/releases/v1.0.135.md)

Adds Live TV sources to the desktop app.

### [1.0.134](docs/releases/v1.0.134.md)

Adds desktop system media controls and hardens native runtime packaging.

### [1.0.133](docs/releases/v1.0.133.md)

Updates desktop playback controls and subtitle placement.

### [1.0.132](docs/releases/v1.0.132.md)

Fixes the desktop player after native playback ends and allows completed items to be played again.

### [1.0.131](docs/releases/v1.0.131.md)

Fixes LibVLC audio and subtitle track selection and keeps subtitle timing aligned with playback.

### [1.0.130](docs/releases/v1.0.130.md)

Unifies the desktop and client playback paths, improves native playback startup and metadata fallbacks, and fixes release lint and typecheck failures.

### [1.0.129](docs/releases/v1.0.129.md)

Improves responsive browser layouts and detail-page navigation. It also fixes Windows native playback, profile checks, and browser or HLS fallback behavior.

### [1.0.128](docs/releases/v1.0.128.md)

Refines desktop playback controls, artwork, home and detail views, discovery, onboarding, and theme settings.

### [1.0.127](docs/releases/v1.0.127.md)

Improves desktop playback, LAN discovery, artwork, ratings, themes, and mobile connection handling.

### [1.0.126](docs/releases/v1.0.126.md)

Refreshes the desktop builds and fixes the security configuration for the mobile release gate.

### [1.0.125](docs/releases/v1.0.125.md)

Fixes browser host detection, artwork editing, and custom-folder navigation.

### [1.0.124](docs/releases/v1.0.124.md)

Makes packaging and multi-platform release publishing more tolerant of temporary download and upload failures.

### [1.0.123](docs/releases/v1.0.123.md)

Refreshes desktop builds with custom libraries, the artwork picker, and the Windows native-module fix.

### [1.0.122](docs/releases/v1.0.122.md)

Adds custom video libraries, improves artwork selection, and fixes Windows release packaging.

### [1.0.121](docs/releases/v1.0.121.md)

Keeps custom-folder videos separate from the main libraries and improves artwork selection and metadata refreshes.

### [1.0.120](docs/releases/v1.0.120.md)

Makes metadata refreshes cache-first and preserves saved metadata, artwork choices, and ratings when providers return no match.

## Full history

Every version has a Markdown file in [`docs/releases`](docs/releases/). GitHub Releases contains the corresponding public downloads and update assets.
