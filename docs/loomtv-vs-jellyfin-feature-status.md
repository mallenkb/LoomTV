# LoomTV feature status vs Jellyfin

Last reviewed: 2026-08-01  
LoomTV baseline: 1.0.102

This is the maintained Markdown version of the feature matrix in
[`loomtv-vs-jellyfin-feature-comparison.html`](../loomtv-vs-jellyfin-feature-comparison.html).
Percentages estimate LoomTV implementation completion, not parity with
Jellyfin's maturity, client coverage, or plugin ecosystem. A partial feature
can be usable today while still missing important server, platform, or
production-validation work.

## Summary

- ✅ **Implemented:** usable in the current desktop or paired-LAN product.
- 🟡 **Partial:** a meaningful implementation exists, but scope or validation is incomplete.
- 🔴 **Not started:** no comparable LoomTV capability is currently shipped.

The highest-value remaining work is production hardware/HDR validation, richer
library organization, durable NAS restart validation, and TV/living-room
clients.

## Priority roadmap

The original implementation order is retained; the feature cell now carries
the current completion percentage and status.

| Priority | Feature | Why it comes first |
| --- | --- | --- |
| P0 | True headless server runtime — **100% · ✅ Done** | Everything else depends on running without Electron, a desktop session, tray, or display. |
| P0 | Docker/Compose and NAS deployment — **90% · 🟡 Partial** | Makes LoomTV installable on Unraid, TrueNAS, Synology-style hosts, Linux servers, and mini PCs; real NAS/GPU matrix validation remains. |
| P0 | NAS-safe library engine — **95% · 🟡 Partial** | Prevents an offline share from appearing as deleted media and makes large network scans reliable; durable restart-resume validation remains. |
| P1 | Hosted web client and admin UI — **75% · 🟡 Partial** | A headless server needs browser-based onboarding, library management, playback, profiles, progress, and diagnostics; `/app/` provides a working viewer MVP and `/admin/` the control plane, but artwork, series browsing, and real capability negotiation remain. |
| P1 | Backup, restore, health, and logs — **85% · 🟡 Partial** | Essential for trusting LoomTV as an always-on appliance; checksummed restore with rollback points is implemented and covered by an automated round-trip test, but a restore drill on a real deployment and cross-version compatibility remain. |
| P1 | Client-aware hardware transcoding — **80% · 🟡 Partial** | Necessary for multiple devices, lower-powered NAS hardware, HDR, and TV playback; physical GPU and HDR validation remains. |
| P2 | Android TV/Fire TV client — **0% · 🔴 Not started** | The highest-value client once the independent server exists. |
| P2 | Collections, versions, extras, and NFO — **0% · 🔴 Not started** | Improves serious video libraries without expanding into unrelated media types. |
| P2 | Public, versioned API — **80% · 🟡 Partial** | Enables community clients and integrations without committing to a plugin runtime; `/api/v1`, discovery, OpenAPI metadata, bearer scopes, and series grouping are implemented and contract-tested. SDK examples, webhooks, and a written compatibility policy remain. |

## Kanban board

A compact status view for quick scanning. Full “Left” and “Why it matters” details are listed in the expanded notes below.

| ✅ Done (33) | 🟡 Partial (17) | 🔴 Not started (15) |
| :--- | :--- | :--- |
| **Local-first / self-hosted — 100%** | **Architecture — 95%** | **Music libraries — 0%**; **Internet remote streaming — 0%** |
| **Desktop platforms — 100%** | **Headless / always-on server — 95%** | **Photos — 0%** |
| **Open source — 100%** | &nbsp; | **Books & comics — 0%** |
| **Application updates — 100%** | **Multiple folders & NAS — 95%** | **Live TV & internet radio — 0%** |
| **Movies — 100%** | **Scanning & scheduling — 90%** | **DVR recording — 0%** |
| **TV shows — 100%** | **Hardware transcoding — 80%** | **Local NFO metadata — 0%** |
| **Anime — 100%** | **HDR / Dolby Vision tone mapping — 70%** | **Collections & playlists — 0%** |
| **Other / mixed videos — 100%** | **Chapters & trickplay previews — 60%** | **Extras, editions & versions — 0%** |
| **Metadata providers — 100%** | &nbsp; | &nbsp; |
| **Fix match / refresh one item — 100%** | **Granular user permissions — 90%** | **Watch together / SyncPlay — 0%** |
| **Artwork control — 100%** | **Credentials & lockout — 90%** | **Offline downloads — 0%** |
| **Search & library filters — 100%** | **Mobile clients — 95%** | **Casting, DLNA & device control — 0%** |
| **Favorites / watchlist — 100%** | **Hosted web client — 75%** | **TV & console clients — 0%** |
| **Direct play — 100%** | **TLS, proxy & network policy — 70%** | **Plugin system — 0%** |
| **Remux & transcoding — 100%** | **Multiple saved servers — 45%** | **Notifications & webhooks — 0%** |
| **Native desktop engine — 100%** | **Backup & restore — 85%** | &nbsp; |
| **Audio & subtitle tracks — 100%** | **Device & session management — 75%** | &nbsp; |
| **Automatic subtitle downloads — 100%** | **Public API & integrations — 80%** | &nbsp; |
| **Subtitle styling & dual subtitles — 100%** | **Admin dashboard, logs & reports — 95%** | &nbsp; |
| **Playback speed & seeking — 100%** | &nbsp; | &nbsp; |
| **Resume, watched state & history — 100%** | &nbsp; | &nbsp; |
| **Continue Watching — 100%** | &nbsp; | &nbsp; |
| **Next-episode autoplay — 100%** | &nbsp; | &nbsp; |
| **Skip intro / recap / outro / credits — 100%** | &nbsp; | &nbsp; |
| **Multiple viewers — 100%** | &nbsp; | &nbsp; |
| **Admin separation — 100%** | &nbsp; | &nbsp; |
| **Parental controls — 100%** | &nbsp; | &nbsp; |
| **Temporary Guest profile — 100%** | &nbsp; | &nbsp; |
| **Profile export & import — 100%** | &nbsp; | &nbsp; |
| **Per-profile preferences — 100%** | &nbsp; | &nbsp; |
| **LAN discovery & pairing — 100%** | &nbsp; | &nbsp; |
| **Remote desktop client — 100%** | &nbsp; | &nbsp; |
| **Themes & UI customization — 100%** | &nbsp; | &nbsp; |



## Detailed card notes


The expanded text cards below mirror the table for readers who prefer a
linear backlog view.

### ✅ Done (33)

- [x] **Local-first / self-hosted — 100%**
  - **What's left:** Nothing for the current desktop scope.
  - **Why it matters:** Keeps media, profiles, and progress under the owner's control.
- [x] **Desktop platforms — 100%**
  - **What's left:** Continue normal release validation.
  - **Why it matters:** Makes the existing product useful across major desktop hosts.
- [x] **Open source — 100%**
  - **What's left:** Keep license and dependency provenance current.
  - **Why it matters:** Enables trust, self-hosting, and community contribution.
- [x] **Application updates — 100%**
  - **What's left:** Document image tags, digests, rollback, and unattended container upgrades.
  - **Why it matters:** NAS operators need safe upgrades without a desktop session.
- [x] **Movies — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** The primary library workflow is complete.
- [x] **TV shows — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Series, seasons, episodes, and continuation work end to end.
- [x] **Anime — 100%**
  - **What's left:** No core gap; continue provider maintenance.
  - **Why it matters:** Anime is a genuine LoomTV differentiator.
- [x] **Other / mixed videos — 100%**
  - **What's left:** No core gap for supported video files; continue maintaining classifier rules as new naming conventions appear.
  - **Why it matters:** Lets users keep home videos and unusual media in mixed folders without manual sorting or losing files.
- [x] **Metadata providers — 100%**
  - **What's left:** No core gap; maintain provider fallbacks and credentials.
  - **Why it matters:** Good metadata is central to discovery and matching.
- [x] **Fix match / refresh one item — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Gives users a safe recovery path for imperfect matches.
- [x] **Artwork control — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Lets users correct the visual library without rescanning everything.
- [x] **Search & library filters — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Makes large collections usable.
- [x] **Favorites / watchlist — 100%**
  - **What's left:** No core gap; preserve cross-client sync.
  - **Why it matters:** Provides lightweight personal curation today.
- [x] **Direct play — 100%**
  - **What's left:** Continue expanding client compatibility profiles.
  - **Why it matters:** Direct play is the lowest-cost, highest-quality NAS path.
- [x] **Remux & transcoding — 100%**
  - **What's left:** Keep software fallback and HLS lifecycle stable under load.
  - **Why it matters:** Allows incompatible clients to play the same library.
- [x] **Native desktop engine — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** MPV gives desktop users reliable playback and track control.
- [x] **Audio & subtitle tracks — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Track choice is essential for international and anime libraries.
- [x] **Automatic subtitle downloads — 100%**
  - **What's left:** Continue quota/error handling across providers.
  - **Why it matters:** Reduces manual preparation before playback.
- [x] **Subtitle styling & dual subtitles — 100%**
  - **What's left:** No core gap for supported desktop playback.
  - **Why it matters:** Dual subtitles are a major anime and language-learning advantage.
- [x] **Playback speed & seeking — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Makes long-form playback comfortable and recoverable.
- [x] **Resume, watched state & history — 100%**
  - **What's left:** No core gap; keep cross-runtime migration and restart validation current.
  - **Why it matters:** Cross-device continuity is expected from a media server.
- [x] **Continue Watching — 100%**
  - **What's left:** Keep profile progress synchronization stable in the hosted client.
  - **Why it matters:** It is the primary re-entry point for most viewers.
- [x] **Next-episode autoplay — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Keeps episodic viewing frictionless.
- [x] **Skip intro / recap / outro / credits — 100%**
  - **What's left:** No core gap; keep analysis costs controllable.
  - **Why it matters:** A focused LoomTV differentiator for series and anime.
- [x] **Multiple viewers — 100%**
  - **What's left:** No core gap; keep profile ownership and progress isolation aligned across clients.
  - **Why it matters:** Household profiles prevent shared recommendations and progress from colliding.
- [x] **Admin separation — 100%**
  - **What's left:** No core gap; keep every new admin route owner-protected.
  - **Why it matters:** Limits destructive operations to trusted owners.
- [x] **Parental controls — 100%**
  - **What's left:** Carry Kids restrictions into headless and web playback.
  - **Why it matters:** Makes a shared NAS safe for children.
- [x] **Temporary Guest profile — 100%**
  - **What's left:** No core gap.
  - **Why it matters:** Supports short-lived household access without permanent accounts.
- [x] **Profile export & import — 100%**
  - **What's left:** No core gap; keep hosted profile and watch-state data in backup/restore snapshots.
  - **Why it matters:** Makes migration and backup less risky.
- [x] **Per-profile preferences — 100%**
  - **What's left:** Expose preferences consistently in the web client.
  - **Why it matters:** Preserves each viewer's playback and discovery experience.
- [x] **LAN discovery & pairing — 100%**
  - **What's left:** No core gap; keep pairing tokens revocable.
  - **Why it matters:** Makes same-LAN setup approachable without exposing NAS credentials.
- [x] **Remote desktop client — 100%**
  - **What's left:** No core gap for same-LAN desktop use.
  - **Why it matters:** Provides a mature client while headless work continues.
- [x] **Themes & UI customization — 100%**
  - **What's left:** No core gap; keep headless theme tokens aligned with desktop.
  - **Why it matters:** Preserves a cohesive LoomTV identity across clients.

### 🟡 Partial (17)

- [ ] **Architecture — 95%**
  - **What's left:** Unify the desktop and headless database, scanner, playback, and profile core.
  - **Why it matters:** Prevents desktop/server behavior from drifting.
- [ ] **Headless / always-on server — 95%**
  - **What's left:** Move profiles/watch state and the full database contract into the server; verify restart and mount-loss recovery on real NAS hosts.
  - **Why it matters:** This is the foundation for a dependable NAS appliance.
- [ ] **Multiple folders & NAS — 95%**
  - **What's left:** Finish mount identity checks, durable resume across process restarts, and real NAS validation.
  - **Why it matters:** Prevents an offline share from looking like an empty library.
- [ ] **Scanning & scheduling — 90%**
  - **What's left:** Add deeper job scheduling, cancellation, throttling, and durable resume.
  - **Why it matters:** Keeps large libraries current without monopolizing NAS resources.
- [ ] **Hardware transcoding — 80%**
  - **What's left:** Validate Intel, NVIDIA, AMD, Apple Silicon, and Rockchip devices end to end, including decode/encode fallback under load.
  - **Why it matters:** Reduces CPU load and enables more concurrent NAS streams.
- [ ] **HDR / Dolby Vision tone mapping — 70%**
  - **What's left:** Prove HDR/HLG/Dolby Vision-to-SDR paths with hardware and software tests.
  - **Why it matters:** Prevents washed-out, green, or unplayable HDR on SDR clients.
- [ ] **Chapters & trickplay previews — 60%**
  - **What's left:** Build scheduled timeline/keyframe preview generation.
  - **Why it matters:** Makes long movies and episodes easier to navigate.
- [ ] **Granular user permissions — 90%**
  - **What's left:** Add topology-aware remote policy enforcement, richer device/session history, and client-facing download/delete controls.
  - **Why it matters:** Needed for larger households and invited users.
- [ ] **Credentials & lockout — 90%**
  - **What's left:** Add a user-safe recovery flow, built-in HTTPS certificate handling, and operational audit/alerting around lockouts.
  - **Why it matters:** Protects an always-on server from password abuse.
- [ ] **Mobile clients — 95%**
  - **What's left:** Execute the tracked physical iOS/Android phone-and-tablet release matrix and complete account-owned App Store/Google Play provisioning.
  - **Why it matters:** Phones and tablets are the most common remote screens.
- [ ] **Hosted web client — 75%**
  - **What's left:** No core gap; `/app/` now provides onboarding, sign-in, profiles, library browsing, direct playback, HLS fallback, progress sync, and capability-aware controls.
  - **Why it matters:** Makes a NAS usable from any modern browser without installing LoomTV.
- [ ] **TLS, proxy & network policy — 70%**
  - **What's left:** Add built-in certificate lifecycle, strict external-media transport checks, and readiness semantics for a reverse proxy.
  - **Why it matters:** Protects admin credentials and streaming sessions on real networks.
- [ ] **Multiple saved servers — 45%**
  - **What's left:** Add server list, switching, per-server tokens, and connection health.
  - **Why it matters:** Supports users with more than one desktop or NAS host.
- [ ] **Backup & restore — 85%**
  - **What's left:** No core gap; checksummed versioned envelopes, legacy restore migration, automatic rollback points, hosted profile/progress inclusion, and session revocation are implemented. Media bytes remain the NAS backup system's responsibility.
  - **Why it matters:** An unattended NAS needs recovery, not only backup creation.
- [ ] **Device & session management — 75%**
  - **What's left:** Add richer stream history, device naming/approval, termination from the dashboard, and reports.
  - **Why it matters:** Helps owners diagnose and control concurrent playback.
- [ ] **Public API & integrations — 80%**
  - **What's left:** No core API gap; `/api/v1`, discovery, OpenAPI metadata, bearer scopes, profile/progress resources, media links, diagnostics, and compatibility examples are documented. Webhooks remain a separate notifications feature.
  - **Why it matters:** Lets automation and third-party clients build on LoomTV safely.
- [ ] **Admin dashboard, logs & reports — 95%**
  - **What's left:** Add export formats and long-term analytics beyond the retained operational log window.
  - **Why it matters:** Reduces time to diagnose NAS and playback failures.

### 🔴 Not started (15)

- [ ] **Music libraries — 0%**
  - **What's left:** Add albums, artists, tags, queues, lyrics, and an audio player.
  - **Why it matters:** Expands LoomTV into a broader household media server.
- [ ] **Photos — 0%**
  - **What's left:** Add photo libraries, albums, browsing, and image delivery.
  - **Why it matters:** Covers another major NAS use case.
- [ ] **Books & comics — 0%**
  - **What's left:** Add ebook/comic/PDF metadata and reading clients.
  - **Why it matters:** Matches Jellyfin's broader personal-media scope.
- [ ] **Live TV & internet radio — 0%**
  - **What's left:** Add tuner/IPTV/radio models, channel guide, and playback.
  - **Why it matters:** Required for true live-media-server parity.
- [ ] **DVR recording — 0%**
  - **What's left:** Add schedules, recording storage, conflict handling, and permissions.
  - **Why it matters:** Turns live TV into an unattended NAS workflow.
- [ ] **Local NFO metadata — 0%**
  - **What's left:** Read and write standard `.nfo` sidecars.
  - **Why it matters:** Improves interoperability and protects metadata outside SQLite.
- [ ] **Collections & playlists — 0%**
  - **What's left:** Add manual, smart, ordered, and cross-library lists.
  - **Why it matters:** A major organization gap for serious libraries.
- [ ] **Extras, editions & versions — 0%**
  - **What's left:** Model alternate cuts, trailers, featurettes, and grouped duplicates.
  - **Why it matters:** Important for collectors with multiple releases of the same film.
- [ ] **Watch together / SyncPlay — 0%**
  - **What's left:** Add synchronized rooms, clocks, controls, and invitations.
  - **Why it matters:** Enables shared viewing across households and devices.
- [ ] **Offline downloads — 0%**
  - **What's left:** Add download permissions, encrypted/cache-aware storage, and expiry.
  - **Why it matters:** Makes mobile playback viable away from the NAS.
- [ ] **Casting, DLNA & device control — 0%**
  - **What's left:** Add Chromecast/AirPlay/DLNA discovery, handoff, and remote control.
  - **Why it matters:** Extends playback from personal screens to living rooms.
- [ ] **TV & console clients — 0%**
  - **What's left:** Build Android TV/Fire TV first, then target a major TV or console platform.
  - **Why it matters:** Expands LoomTV into the living room where Jellyfin is strongest.
- [ ] **Plugin system — 0%**
  - **What's left:** Define a sandboxed extension API, permissions, packaging, and lifecycle.
  - **Why it matters:** Would close Jellyfin's largest ecosystem advantage.
- [ ] **Notifications & webhooks — 0%**
  - **What's left:** Add event subscriptions for scans, failures, backups, sessions, and updates.
  - **Why it matters:** Makes an always-on server observable without constant polling.

- [ ] **Internet remote streaming — 0%**
  - **What's left:** Define a secure remote-access model, TLS, identity, rate limits, and relay/reverse-proxy guidance.
  - **Why it matters:** Enables away-from-home use without unsafe port exposure.

## Platform and deployment

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| Local-first / self-hosted | 100% | ✅ Done | Nothing for the current desktop scope. | Keeps media, profiles, and progress under the owner's control. |
| Architecture | 95% | 🟡 Partial | Finish the shared persistence contract for profiles, watch state, and the desktop database adapter. | Prevents desktop/server behavior from drifting. |
| Desktop platforms | 100% | ✅ Done | Continue normal release validation. | Makes the existing product useful across major desktop hosts. |
| Headless / always-on server | 95% | 🟡 Partial | Hosted watch state is now durable SQLite and the catalog carries shared movie/episode classification; the remaining work is online metadata providers, the full desktop database contract, and restart/mount-loss verification on real NAS hosts. | This is the foundation for a dependable NAS appliance. |
| Open source | 100% | ✅ Done | Keep license and dependency provenance current. | Enables trust, self-hosting, and community contribution. |
| Application updates | 100% | ✅ Done | Document image tags, digests, rollback, and unattended container upgrades. | NAS operators need safe upgrades without a desktop session. |

## Library and discovery

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| Movies | 100% | ✅ Done | No core gap. | The primary library workflow is complete. |
| TV shows | 100% | ✅ Done | No core gap. | Series, seasons, episodes, and continuation work end to end. |
| Anime | 100% | ✅ Done | No core gap; continue provider maintenance. | Anime is a genuine LoomTV differentiator. |
| Other / mixed videos | 100% | ✅ Done | No core gap for supported video files; mixed roots retain every file, classify structured TV/anime folders, and keep ambiguous loose files playable. | Lets users keep home videos and unusual media in mixed folders without manual sorting or losing files. |
| Music libraries | 0% | 🔴 Not started | Add albums, artists, tags, queues, lyrics, and an audio player. | Expands LoomTV into a broader household media server. |
| Photos | 0% | 🔴 Not started | Add photo libraries, albums, browsing, and image delivery. | Covers another major NAS use case. |
| Books & comics | 0% | 🔴 Not started | Add ebook/comic/PDF metadata and reading clients. | Matches Jellyfin's broader personal-media scope. |
| Live TV & internet radio | 0% | 🔴 Not started | Add tuner/IPTV/radio models, channel guide, and playback. | Required for true live-media-server parity. |
| DVR recording | 0% | 🔴 Not started | Add schedules, recording storage, conflict handling, and permissions. | Turns live TV into an unattended NAS workflow. |
| Multiple folders & NAS | 95% | 🟡 Partial | Finish mount identity checks, durable resume across process restarts, and real NAS validation. | Prevents an offline share from looking like an empty library. |
| Scanning & scheduling | 90% | 🟡 Partial | Quick/metadata/full modes now behave distinctly (quick preserves unchanged records; metadata/full rebuild classification); deeper job scheduling, cancellation, throttling, and durable resume remain. | Keeps large libraries current without monopolizing NAS resources. |
| Metadata providers | 100% | ✅ Done | No core gap; maintain provider fallbacks and credentials. | Good metadata is central to discovery and matching. |
| Fix match / refresh one item | 100% | ✅ Done | No core gap. | Gives users a safe recovery path for imperfect matches. |
| Artwork control | 100% | ✅ Done | No core gap. | Lets users correct the visual library without rescanning everything. |
| Local NFO metadata | 0% | 🔴 Not started | Read and write standard `.nfo` sidecars. | Improves interoperability and protects metadata outside SQLite. |
| Search & library filters | 100% | ✅ Done | No core gap. | Makes large collections usable. |
| Collections & playlists | 0% | 🔴 Not started | Add manual, smart, ordered, and cross-library lists. | A major organization gap for serious libraries. |
| Favorites / watchlist | 100% | ✅ Done | No core gap; preserve cross-client sync. | Provides lightweight personal curation today. |
| Extras, editions & versions | 0% | 🔴 Not started | Model alternate cuts, trailers, featurettes, and grouped duplicates. | Important for collectors with multiple releases of the same film. |

## Playback

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| Direct play | 100% | ✅ Done | Continue expanding client compatibility profiles. | Direct play is the lowest-cost, highest-quality NAS path. |
| Remux & transcoding | 100% | ✅ Done | Keep software fallback and HLS lifecycle stable under load. | Allows incompatible clients to play the same library. |
| Native desktop engine | 100% | ✅ Done | No core gap. | MPV gives desktop users reliable playback and track control. |
| Hardware transcoding | 80% | 🟡 Partial | Validate Intel, NVIDIA, AMD, Apple Silicon, and Rockchip devices end to end, including decode/encode fallback under load. | Reduces CPU load and enables more concurrent NAS streams. |
| HDR / Dolby Vision tone mapping | 70% | 🟡 Partial | Prove HDR/HLG/Dolby Vision-to-SDR paths with hardware and software tests. | Prevents washed-out, green, or unplayable HDR on SDR clients. |
| Audio & subtitle tracks | 100% | ✅ Done | No core gap. | Track choice is essential for international and anime libraries. |
| Automatic subtitle downloads | 100% | ✅ Done | Continue quota/error handling across providers. | Reduces manual preparation before playback. |
| Subtitle styling & dual subtitles | 100% | ✅ Done | No core gap for supported desktop playback. | Dual subtitles are a major anime and language-learning advantage. |
| Playback speed & seeking | 100% | ✅ Done | No core gap. | Makes long-form playback comfortable and recoverable. |
| Resume, watched state & history | 100% | ✅ Done | No core gap; keep cross-runtime migration and restart validation current. | Cross-device continuity is expected from a media server. |
| Continue Watching | 100% | ✅ Done | Keep profile progress synchronization stable in the hosted client. | It is the primary re-entry point for most viewers. |
| Next-episode autoplay | 100% | ✅ Done | No core gap. | Keeps episodic viewing frictionless. |
| Skip intro / recap / outro / credits | 100% | ✅ Done | No core gap; keep analysis costs controllable. | A focused LoomTV differentiator for series and anime. |
| Chapters & trickplay previews | 60% | 🟡 Partial | Build scheduled timeline/keyframe preview generation. | Makes long movies and episodes easier to navigate. |
| Watch together / SyncPlay | 0% | 🔴 Not started | Add synchronized rooms, clocks, controls, and invitations. | Enables shared viewing across households and devices. |
| Offline downloads | 0% | 🔴 Not started | Add download permissions, encrypted/cache-aware storage, and expiry. | Makes mobile playback viable away from the NAS. |
| Casting, DLNA & device control | 0% | 🔴 Not started | Add Chromecast/AirPlay/DLNA discovery, handoff, and remote control. | Extends playback from personal screens to living rooms. |

## Profiles, permissions, and security

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| Multiple viewers | 100% | ✅ Done | No core gap; keep profile ownership and progress isolation aligned across clients. | Household profiles prevent shared recommendations and progress from colliding. |
| Admin separation | 100% | ✅ Done | No core gap; keep every new admin route owner-protected. | Limits destructive operations to trusted owners. |
| Parental controls | 100% | ✅ Done | Carry Kids restrictions into headless and web playback. | Makes a shared NAS safe for children. |
| Granular user permissions | 90% | 🟡 Partial | Add topology-aware remote policy enforcement, richer device/session history, and client-facing download/delete controls. | Needed for larger households and invited users. |
| Credentials & lockout | 90% | 🟡 Partial | Add a user-safe recovery flow, built-in HTTPS certificate handling, and operational audit/alerting around lockouts. | Protects an always-on server from password abuse. |
| Temporary Guest profile | 100% | ✅ Done | No core gap. | Supports short-lived household access without permanent accounts. |
| Profile export & import | 100% | ✅ Done | No core gap; keep hosted profile and watch-state data in backup/restore snapshots. | Makes migration and backup less risky. |
| Per-profile preferences | 100% | ✅ Done | Expose preferences consistently in the web client. | Preserves each viewer's playback and discovery experience. |

## Networking and clients

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| LAN discovery & pairing | 100% | ✅ Done | No core gap; keep pairing tokens revocable. | Makes same-LAN setup approachable without exposing NAS credentials. |
| Remote desktop client | 100% | ✅ Done | No core gap for same-LAN desktop use. | Provides a mature client while headless work continues. |
| Mobile clients | 95% | 🟡 Partial | The same-LAN client, cold-start offline catalog, outage recovery, and reproducible preview/production build profiles are implemented; physical device/store sign-off remains. | Phones and tablets are the most common remote screens. |
| TV & console clients | 0% | 🔴 Not started | Build Android TV/Fire TV first, then target a major TV or console platform. | Expands LoomTV into the living room where Jellyfin is strongest. |
| Hosted web client | 75% | 🟡 Partial | `/app/` covers onboarding, profiles, library browsing, direct/HLS playback, and progress sync; artwork, series browsing UI, richer progress editing, and real capability negotiation remain. | Makes a NAS usable from any modern browser without installing LoomTV. |
| Internet remote streaming | 0% | 🔴 Not started | Define a secure remote-access model, TLS, identity, rate limits, and relay/reverse-proxy guidance. | Enables away-from-home use without unsafe port exposure. |
| TLS, proxy & network policy | 70% | 🟡 Partial | Add built-in certificate lifecycle, strict external-media transport checks, and readiness semantics for a reverse proxy. | Protects admin credentials and streaming sessions on real networks. |
| Multiple saved servers | 45% | 🟡 Partial | Add server list, switching, per-server tokens, and connection health. | Supports users with more than one desktop or NAS host. |

## Operations, ecosystem, and customization

| Feature | Completion | Status | What's left | Why it matters |
| --- | ---: | --- | --- | --- |
| Backup & restore | 85% | 🟡 Partial | Checksummed snapshots, rollback artifacts, hosted profile/progress inclusion, and session revocation are implemented and round-trip tested; a restore drill on a real deployment and cross-version compatibility remain. | An unattended NAS needs recovery, not only backup creation. |
| Device & session management | 75% | 🟡 Partial | Add richer stream history, device naming/approval, termination from the dashboard, and reports. | Helps owners diagnose and control concurrent playback. |
| Plugin system | 0% | 🔴 Not started | Define a sandboxed extension API, permissions, packaging, and lifecycle. | Would close Jellyfin's largest ecosystem advantage. |
| Public API & integrations | 80% | 🟡 Partial | `/api/v1`, discovery, OpenAPI metadata, scopes, profile/progress/media resources, and series grouping are implemented and contract-tested; SDK examples, webhooks, and a written compatibility policy remain. | Lets automation and third-party clients build on LoomTV safely. |
| Admin dashboard, logs & reports | 95% | 🟡 Partial | Add export formats and long-term analytics beyond the retained operational log window. | Reduces time to diagnose NAS and playback failures. |
| Notifications & webhooks | 0% | 🔴 Not started | Add event subscriptions for scans, failures, backups, sessions, and updates. | Makes an always-on server observable without constant polling. |
| Themes & UI customization | 100% | ✅ Done | No core gap; keep headless theme tokens aligned with desktop. | Preserves a cohesive LoomTV identity across clients. |

## Recommended implementation order

1. **Hosted browser playback** — turn the headless server into a complete NAS client, including profiles and watch-state sync.
2. **Hardware and HDR validation** — test Intel, NVIDIA, AMD, Apple Silicon, and Rockchip paths on real hosts.
3. **Collections, versions, extras, and NFO** — improve large-library organization and interoperability.
4. **Public API, webhooks, and device/session controls** — make LoomTV useful to other self-hosted tools.
5. **TV/living-room clients** — target Android TV/Fire TV first, then one major smart-TV platform.
6. **Downloads, casting, DLNA, and SyncPlay** — add convenience and multi-device workflows.
7. **Live TV/DVR, plugins, music, photos, and books** — pursue only if broad Jellyfin parity is an explicit product goal.

## Verification still required

- Build and run Docker Compose on a real NAS, including restart and offline-mount scenarios.
- Verify non-root permissions, read-only media, backup restore, and multi-architecture images.
- Run physical GPU self-tests and end-to-end HLS playback for each supported backend.
- ~~Add automated server tests for authentication, scan checkpoints, corrupt state, path safety, and mount loss.~~ Done: `apps/server/tests/` covers auth/lockout, backup/restore round-trip, tampered backups, path escape, offline roots, scan modes, classification, SQLite watch-state migration, and the `/api/v1` contract end to end.
- Reconcile the headless README and audit artifacts whenever these percentages change.
