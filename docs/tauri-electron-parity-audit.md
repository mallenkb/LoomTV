# LoomTV Electron vs Tauri Parity Audit

Updated: 2026-05-20

Legend: ✅ parity / working, ❌ not yet equal to Electron.

| Summary | Count |
|---|---:|
| Full feature rows listed | 108 |
| ✅ Tauri parity / working | 108 |
| ❌ Remaining non-parity gaps | 0 |

## Full Feature Matrix

| Area | Feature | Electron behavior | Tauri status | Tauri implementation / gap |
|---|---|---|---:|---|
| App shell | Shared renderer boot | Electron loads the Vite/React renderer and owns the desktop bridge. | ✅ | Tauri loads the same renderer through the Tauri webview and keeps the app UI shared. |
| App shell | Desktop API facade | Renderer calls one desktop API layer instead of calling Electron directly. | ✅ | `src/lib/desktopApi.ts` routes Tauri calls through Tauri commands while preserving the renderer contract. |
| App shell | Environment detection | Electron exposes desktop capabilities and renderer fallbacks. | ✅ | Tauri detection is wired into the desktop API so browser, Electron, and Tauri modes resolve correctly. |
| App shell | macOS titlebar overlay | Electron uses a custom top chrome with native traffic-light controls visible. | ✅ | Tauri uses hidden titlebar/overlay mode, keeps traffic-light controls, and removes the extra header bar. |
| App shell | Sidebar drag region | Electron keeps the sidebar draggable without blocking controls. | ✅ | Tauri sidebar drag regions are scoped so the window can move and controls remain clickable. |
| App shell | Sidebar logo spacing | Electron positions the logo below macOS system controls. | ✅ | Tauri sidebar logo spacing was moved down to avoid blending into the native controls. |
| App shell | Fullscreen and windowed layout | Electron adjusts nav/logo placement when not fullscreen. | ✅ | Tauri layout keeps the same spacing behavior in windowed mode. |
| App shell | Update state events | Electron pushes update lifecycle events into the renderer. | ✅ | Tauri now emits `updates:state` and the renderer listens through the shared desktop API. |
| Database | SQLite storage | Electron persists app data in SQLite. | ✅ | Tauri uses bundled `rusqlite` and creates the LoomTV SQLite database. |
| Database | Database schema | Electron stores libraries, media, seasons, episodes, files, progress, artwork, settings, and caches. | ✅ | Tauri creates the equivalent schema for library folders, media items, episode rows, episode files, playback, artwork, scan cache, and artwork cache. |
| Database | WAL and constraints | Electron configures SQLite for desktop reliability. | ✅ | Tauri enables WAL, foreign keys, and busy timeout. |
| Database | Legacy JSON migration | Electron-era JSON data can be imported into SQLite. | ✅ | Tauri migrates legacy JSON library/progress/artwork/settings records into the database. |
| Database | Library folder persistence | Electron persists folders by group and path. | ✅ | Tauri stores and returns movie, TV, anime, and other folders through SQLite-backed commands. |
| Database | Media item persistence | Electron stores scanned media metadata as durable records. | ✅ | Tauri persists movies, shows, anime, other videos, metadata, artwork references, and scan state. |
| Database | Season persistence | Electron keeps structured season rows for shows/anime. | ✅ | Tauri persists season records and links them to media items. |
| Database | Episode persistence | Electron keeps episode records with titles, numbers, metadata, and files. | ✅ | Tauri persists episode rows plus episode file rows for multi-file and multi-season series. |
| Database | Playback progress | Electron resumes watched media and stores progress state. | ✅ | Tauri saves/imports playback progress through SQLite. |
| Database | Custom artwork records | Electron stores user-selected poster, backdrop, and logo overrides. | ✅ | Tauri saves/imports custom artwork and reapplies it during library reads. |
| Database | Scan cache table | Electron avoids unnecessary rescans with folder/file signatures. | ✅ | Tauri stores deterministic folder signatures and reuses cached scan results. |
| Database | Artwork cache table | Electron caches remote artwork locally. | ✅ | Tauri stores cached artwork as data URLs and serves it through the local media server. |
| Database | Backup and clear data | Electron can export/clear local app data. | ✅ | Tauri commands cover backup/restore-oriented database access and local library data cleanup. |
| Library | Get folders | Electron lists configured library roots. | ✅ | Tauri returns persisted folder groups from SQLite. |
| Library | Add folder | Electron lets users add local folders into a media group. | ✅ | Tauri validates and saves folders through commands. |
| Library | Remove folder | Electron lets users remove configured library folders. | ✅ | Tauri removes folder records and updates the stored folder list. |
| Library | Folder groups | Electron separates movies, TV shows, anime, and others. | ✅ | Tauri normalizes the same groups and preserves group-specific scanning behavior. |
| Library | Folder picker bridge | Electron opens native folder selection. | ✅ | Tauri command bridge supports native folder selection through the shared renderer API. |
| Library | Movie scanning | Electron treats standalone video files and movie folders as movie entries. | ✅ | Tauri scans movie files/folders and builds movie media items with local metadata and artwork. |
| Library | TV root scanning | Electron treats TV roots as containers of show folders. | ✅ | Tauri follows the same TV root structure instead of flattening shows incorrectly. |
| Library | TV show folder scanning | Electron groups season/episode files under the detected show. | ✅ | Tauri groups TV files under show records and season records. |
| Library | TV season folder scanning | Electron recognizes season folders and episode numbering. | ✅ | Tauri recognizes season folders, `SxxExx` patterns, and episode files. |
| Library | Anime root scanning | Electron follows the anime-specific folder structure. | ✅ | Tauri uses the same anime root/show/episode arrangement. |
| Library | Anime episode parsing | Electron supports anime files with trailing episode numbers. | ✅ | Tauri parses trailing numeric episode forms and associates them with anime series. |
| Library | Specials and skipped extras | Electron avoids samples, extras, trailers, and non-library clutter. | ✅ | Tauri skips extras/samples and ignores subtitle/image files as media entries. |
| Library | Others auto-arrangement | Electron sorts uncategorized folders into movie/TV/anime-like buckets where possible. | ✅ | Tauri auto-arranges others into movie, TV, and anime buckets using the Electron-style heuristics. |
| Library | Quick scan mode | Electron reuses cached scan data when files have not changed. | ✅ | Tauri uses folder signatures to skip unchanged folders. |
| Library | Metadata scan mode | Electron refreshes metadata without always doing full expensive work. | ✅ | Tauri supports metadata-focused scans through the shared scan command. |
| Library | Full scan mode | Electron can force a complete rescan. | ✅ | Tauri bypasses scan cache when full/forced scans are requested. |
| Library | Scan progress | Electron streams scan progress to the renderer. | ✅ | Tauri emits `library:scan-progress` events and the renderer listens through `@tauri-apps/api/event`. |
| Library | Folder signatures | Electron includes relevant media-adjacent files in scan signatures. | ✅ | Tauri signatures include video, subtitle, and image files for deterministic cache invalidation. |
| Library | Local poster detection | Electron picks common local poster filenames. | ✅ | Tauri finds `poster`, `folder`, `cover`, and related poster files. |
| Library | Local backdrop detection | Electron picks local fanart/backdrop files. | ✅ | Tauri finds `fanart`, `backdrop`, and related background image files. |
| Library | Embedded artwork detection | Electron can use embedded attached pictures. | ✅ | Tauri detects attached image streams and exposes them as thumbnail/artwork candidates. |
| Library | Embedded title tags | Electron reads useful media container tags. | ✅ | Tauri reads title, show, year, season, episode, provider IDs, summaries, and artwork stream indexes from ffprobe tags. |
| Metadata | TMDB search | Electron searches TMDB for movies and shows. | ✅ | Tauri supports TMDB search through the same renderer-facing API. |
| Metadata | TMDB details | Electron fetches full TMDB details for selected media. | ✅ | Tauri fetches movie/show details and maps them into the shared metadata shape. |
| Metadata | TMDB season episodes | Electron fills TV episode names from TMDB seasons. | ✅ | Tauri fetches TMDB season episode lists and merges names onto local episodes. |
| Metadata | OMDb search | Electron supports OMDb lookup when configured. | ✅ | Tauri supports OMDb search and maps results into metadata candidates. |
| Metadata | OMDb key validation | Electron validates OMDb API keys. | ✅ | Tauri validates OMDb keys through the metadata command layer. |
| Metadata | Fanart.tv lookup | Electron fetches artwork/logo candidates from Fanart.tv. | ✅ | Tauri supports Fanart.tv lookup and key validation. |
| Metadata | TVmaze show lookup | Electron uses TVmaze for TV series metadata. | ✅ | Tauri fetches TVmaze show details, cast, seasons, and episode lists. |
| Metadata | TVmaze episode names | Electron uses TVmaze episode names when available. | ✅ | Tauri merges TVmaze episode titles, summaries, dates, and stills onto scanned TV episodes. |
| Metadata | Jikan/MAL anime lookup | Electron uses anime-specific metadata providers. | ✅ | Tauri fetches Jikan/MAL anime metadata and candidate results. |
| Metadata | Jikan episode names | Electron fills anime episode names where provider data exists. | ✅ | Tauri fetches Jikan episode lists with rate limiting and merges titles onto anime episodes. |
| Metadata | Provider candidate list | Electron shows official metadata candidates across providers. | ✅ | Tauri candidates include TMDB, TVmaze, Jikan, and OMDb sources. |
| Metadata | Apply official metadata | Electron applies selected provider metadata to local items. | ✅ | Tauri applies selected metadata through the shared command contract. |
| Metadata | Refresh official metadata | Electron refreshes stale metadata from providers. | ✅ | Tauri refreshes metadata and re-merges provider episode fields. |
| Metadata | Episode merge priority | Electron preserves local structure while improving names/artwork. | ✅ | Tauri merges provider data onto scanned files without breaking local season/episode grouping. |
| Artwork | Custom poster save | Electron saves a user-selected poster override. | ✅ | Tauri persists custom poster artwork in SQLite. |
| Artwork | Custom backdrop save | Electron saves a user-selected backdrop override. | ✅ | Tauri persists custom backdrop artwork in SQLite. |
| Artwork | Custom logo save | Electron saves logo overrides for playback/UI branding. | ✅ | Tauri persists logo artwork and returns stored/applied logo candidates. |
| Artwork | Artwork import/export | Electron carries artwork through local app data flows. | ✅ | Tauri imports stored artwork records and applies them during library reads. |
| Artwork | Playback logo lookup | Electron can show a logo during playback/details views. | ✅ | Tauri returns stored/applied logo candidates from custom artwork and metadata sources. |
| Artwork | Local image server | Electron serves local poster/backdrop files to the renderer. | ✅ | Tauri serves `/api/local-image` for safe local artwork display. |
| Artwork | Cached artwork server | Electron serves cached remote artwork locally. | ✅ | Tauri serves `/api/cached-artwork` and persists remote artwork cache entries. |
| Artwork | Embedded image thumbnails | Electron can surface embedded attached pictures. | ✅ | Tauri can render embedded image stream thumbnails through ffmpeg. |
| Media | Local HTTP media server | Electron runs a local media server for playback routes. | ✅ | Tauri serves stream, subtitle, thumbnail, local image, cached artwork, and HLS routes. |
| Media | Direct file streaming | Electron streams local files directly. | ✅ | Tauri streams local media files through the HTTP server. |
| Media | Range requests | Electron supports byte-range seeking. | ✅ | Tauri implements range responses for direct streaming. |
| Media | Subtitle route | Electron serves external subtitle files. | ✅ | Tauri serves local subtitle routes and validates subtitle paths. |
| Media | SRT to VTT conversion | Electron converts SRT subtitles for browser playback. | ✅ | Tauri converts SRT into WebVTT. |
| Media | VTT subtitles | Electron serves existing WebVTT subtitles. | ✅ | Tauri serves VTT files through the subtitle route. |
| Media | Embedded subtitles | Electron can expose embedded subtitle tracks. | ✅ | Tauri probes embedded subtitle tracks and can pass them into ffmpeg transcodes. |
| Media | Subtitle burn-in | Electron supports burning selected subtitles into the video. | ✅ | Tauri builds ffmpeg args for text and bitmap subtitle burn-in. |
| Media | Secondary subtitles | Electron supports secondary subtitle options. | ✅ | Tauri passes primary and secondary subtitle selections through the transcode options. |
| Media | Audio track listing | Electron exposes audio tracks from media probe output. | ✅ | Tauri probe includes audio track indexes, language, title, and codec data. |
| Media | Audio track switching | Electron maps the selected audio stream during playback/transcode. | ✅ | Tauri maps selected audio correctly, and `-1` disables audio. |
| Media | Video track probe | Electron exposes video codec/profile data. | ✅ | Tauri probe includes codecs, dimensions, profile, pixel format, duration, and bitrate. |
| Media | Thumbnail generation | Electron creates thumbnails through ffmpeg. | ✅ | Tauri generates local thumbnails through ffmpeg. |
| Media | Embedded thumbnail generation | Electron uses attached image streams when present. | ✅ | Tauri can thumbnail attached image streams by stream index. |
| Media | HLS session start | Electron starts transcoded HLS sessions. | ✅ | Tauri starts HLS transcode sessions. |
| Media | HLS playlist/segment serving | Electron serves generated HLS playlists and segments. | ✅ | Tauri serves generated HLS output from the transcode directory. |
| Media | HLS session stop | Electron can stop active transcode sessions. | ✅ | Tauri stop command terminates active HLS sessions. |
| Media | Hardware encoder presets | Electron can prefer VideoToolbox, NVENC, or QSV where available. | ✅ | Tauri now supports explicit hardware presets and auto-detects VideoToolbox, NVENC, or QSV before falling back to software H.264. |
| Media | Bundled ffmpeg lookup | Electron can use app-bundled ffmpeg. | ✅ | Tauri checks packaged `resources/ffmpeg/<platform>` before falling back to system binaries. |
| Media | Bundled ffprobe lookup | Electron can use app-bundled ffprobe. | ✅ | Tauri checks packaged `resources/ffmpeg/<platform>` before falling back to system binaries. |
| Media | Tauri bundle resources | Electron packages runtime media binaries with the app. | ✅ | Tauri bundle config includes `../resources/ffmpeg/**/*`. |
| Network | Server LAN binding | Electron binds the media server for LAN access. | ✅ | Tauri media server binds `0.0.0.0`. |
| Network | LAN status endpoint | Electron reports local sharing status and URLs. | ✅ | Tauri returns device identity, share code, addresses, and library URL. |
| Network | Local IP discovery | Electron surfaces reachable local network addresses. | ✅ | Tauri enumerates local addresses for LAN sharing. |
| Network | Share code | Electron uses a short pairing code. | ✅ | Tauri creates and validates a 6-digit share code. |
| Network | Pair device endpoint | Electron pairs LAN clients before library access. | ✅ | Tauri validates the share code and stores paired devices. |
| Network | Device tokens | Electron uses device-level auth tokens. | ✅ | Tauri issues and stores bearer tokens for paired devices. |
| Network | LAN library auth | Electron protects LAN library JSON behind pairing. | ✅ | Tauri requires a valid paired-device token for `/api/lan/library`. |
| Network | mDNS/Bonjour discovery | Electron advertises the app on the LAN through Bonjour. | ✅ | Tauri now advertises and discovers `_loomtv._tcp.local.` services with Rust mDNS-SD. |
| Network | Signed media URLs | Electron signs remote stream/subtitle/artwork URLs more broadly. | ✅ | Tauri rewrites LAN library stream, subtitle, HLS, thumbnail, local-image, and cached-artwork URLs with signed expiring HMAC parameters. |
| Security | Media path validation | Electron prevents serving arbitrary filesystem paths. | ✅ | Tauri only serves media, local image, and subtitle paths inside configured library folders or the transcode directory. |
| Security | Local stream tokens | Electron requires local access tokens for media routes. | ✅ | Tauri stream, subtitle, and HLS routes now require a local access token or a valid signed LAN URL. |
| Security | Artwork route tokens | Electron applies token protection to artwork routes. | ✅ | Tauri thumbnail, local-image, and cached-artwork routes now require a local access token or a valid signed LAN URL. |
| Security | Restricted CORS | Electron restricts response origins. | ✅ | Tauri now emits origin-aware CORS headers for trusted renderer origins instead of wildcard CORS. |
| Updates | GitHub release check | Electron checks for available releases. | ✅ | Tauri checks the latest GitHub release. |
| Updates | Install update action | Electron can send users into the install/update flow. | ✅ | Tauri opens the latest release page when install is requested. |
| Updates | True auto-download/install | Electron has a fuller installer/update path. | ✅ | Tauri now uses the official updater plugin, signed updater config, updater bundle artifacts, and install/restart commands. |
| Packaging | Desktop app bundle | Electron builds a desktop distributable. | ✅ | Tauri debug app and DMG build successfully. |
| Packaging | Resource bundling | Electron packages app resources and runtime helpers. | ✅ | Tauri bundle resources include the ffmpeg resource tree. |
| Testing | Rust database/media tests | Electron parity needs backend behavior covered in Tauri. | ✅ | `cargo test --manifest-path src-tauri/Cargo.toml` passes. |
| Testing | Renderer/Electron tests | Shared renderer behavior must keep passing. | ✅ | `corepack pnpm test` passes. |
| Testing | Renderer production build | Shared UI must still compile. | ✅ | `corepack pnpm run build:renderer` passes. |
| Testing | Tauri bundle build | Tauri app must package successfully. | ✅ | `corepack pnpm exec tauri build --debug` passes and produces a debug DMG plus updater archive/signature. |

## Verification

| Check | Result |
|---|---:|
| `cargo test --manifest-path src-tauri/Cargo.toml` | ✅ 26 passed |
| `corepack pnpm test` | ✅ 18 passed |
| `corepack pnpm run build:renderer` | ✅ passed |
| `corepack pnpm exec tauri build --debug` | ✅ debug app + DMG + updater archive/signature built |

## Remaining Non-Parity Items

| Priority | Gap | Why it remains |
|---|---|---|
| - | ✅ None currently listed | The previously tracked red items are implemented and verified in the Tauri pass. |
