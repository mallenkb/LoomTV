# Media library expansion

The agreed delivery order is Photos, Music, Audiobooks, Books, then Comics and manga. Implementation targets the Electron desktop app. Tauri, mobile, TV, and hosted-browser support are outside this expansion's current scope.

## Storage and client boundaries

Keep one SQLite database file. Each media domain owns separate roots, catalog tables, and progress tables. The shared profile and migration infrastructure remains common. Do not split the application into separate live database files.

Each domain has its own sidebar destination and internal navigation. The video category header belongs only to video routes. Photos, Music, Audiobooks, Books, and Comics must not be inserted into that header. Sidebar dividers and destinations can be rearranged.

The current video database was inspected before this repair and still held 32 media records plus movie, TV, and anime roots. A backup was saved before implementation. No older database was restored over the current catalog.

The running app also reported an encrypted-settings decryption failure. The repair preserves the established runtime name and package app ID. LAN availability checks now fail closed on secret-store errors instead of throwing an uncaught exception that blocks the local catalog. This does not reset or recover missing encryption keys, and the encrypted settings remain intact.

After restarting Electron with the identity repair, the live accessibility tree again showed Movies, TV Shows, and Anime alongside all five media sections. The database still held 32 video records and three video roots. This confirms catalog navigation recovery, not playback or reader coverage.

## Additional media implementation

The Electron bridge and server service now include Music, Audiobooks, Books, and Comics roots, cancellable scanning, paginated search, authorized content delivery, and separate profile progress records. Successful rescans preserve item identities and progress; failed scans preserve the preceding catalog.

Audio indexing reads embedded title, artist, album, disc, track, duration, and chapter metadata through FFprobe. Direct playback depends on Chromium codec support. Indexing an extension does not establish playback support. Audio transcoding, embedded cover extraction, durable playlists, and gapless playback remain follow-up work.

Books index EPUB and PDF. Comics index CBZ and PDF. EPUB and CBZ resources use bounded ZIP entry delivery without extraction to disk. ZIP64, encrypted archives, CBR, CB7, MOBI, and AZW formats are not supported by this first reader implementation.

The four new library screens include folder management, search, pagination, and domain-specific views. Music and audiobooks have direct audio playback, a session queue, chapters, speed, a sleep timer, and saved resume positions. Books have lazy EPUB chapter reading and a PDF viewer. Comics have CBZ page reading and a PDF viewer. EPUB package metadata and ComicInfo metadata supply titles and creators when present. PDF completion is manual; precise PDF page resume is not implemented. Album and creator grouping applies to the current result page.

The added media libraries are local and owner-only. Remote serving, profile sharing, selective export, durable playlists, audiobook bookmarks, and advanced reader controls remain open work. These screens are a first implementation, not release-ready parity with Jellyfin.

Jellyfin references used for folder grouping and capability boundaries:

- [Music organization and metadata](https://jellyfin.org/docs/general/server/media/music/)
- [Books, audiobooks, and comic formats](https://jellyfin.org/docs/general/server/media/books/)
- [Client codec support](https://jellyfin.org/docs/general/clients/codec-support/)

Jellyfin groups audiobooks and comics under Books. Loom deliberately gives them separate client sections. Do not advertise parity with Jellyfin based on extension recognition alone.

## Current milestone: photo folders and viewing

Deliver a complete local workflow:

1. Add a local folder or an OS-mounted NAS folder from Library Settings.
2. Scan JPEG, PNG, and WebP files.
3. Browse the existing folder hierarchy, including nested and empty folders.
4. Switch to All photos, sorted by file modification date.
5. Open a photo in a window-filling viewer and navigate using buttons or arrow keys.
6. Restart the app with the catalog and configured folders preserved.

The first milestone is wired into the Electron app. The running navigation was inspected, but photo scanning, playback, readers, and packaged-app behavior have not been verified end to end. Tests run only when the user explicitly requests them.

Photo libraries initially belong to the owner profile. Other profiles and remote clients must not receive photo records or image previews until explicit sharing and permission controls exist.

## Electron implementation boundary

The Electron renderer currently uses its preload bridge, desktop IPC handlers, and desktop SQLite database for local libraries. The headless canonical store is a separate path. The earlier plan's assumption that all clients already share one persistence path must not be used to justify changing the wrong database.

Add the photo catalog to the existing Electron database, using its migration ledger and whole-database backup. Keep photo roots, directories, and items separate from the video tables and video response types. Do not introduce another database or put photos into movie arrays.

Use a typed, optional photo API on the existing desktop bridge. Requests must pass the existing trusted-sender checks and owner authorization. Image delivery must resolve opaque catalog IDs inside configured roots and recheck authorization after asynchronous work.

The Electron photo library service owns traversal and does not invoke video metadata providers. Preserve the prior catalog when scanning is cancelled, a root disconnects, or traversal fails. Only a completed scan may remove missing entries. Skip symbolic links, retain nested folder names, and never move or rewrite originals.

Generate previews outside the renderer, with bounded concurrency, file size, processing time, output size, and cache use. Check image orientation and metadata removal against fixtures before describing these behaviors as verified. Defer capture-date sorting until EXIF extraction and fallback rules are implemented.

## Photo milestones

| Milestone | Scope | Completion evidence |
| --- | --- | --- |
| Folder workflow | Persistent roots, scan/cancel, folders, breadcrumbs, All photos, previews, viewer | Add, scan, browse, open, navigate, restart; existing videos remain usable |
| Metadata and organization | EXIF capture dates, albums, favorites, slideshows | Orientation/date fixtures, manual organization survives rescans, albums do not move files |
| Release readiness | Upgrade, backup/restore, profile boundaries, disconnected NAS behavior, packaged decoder | Explicitly requested checks and recorded platform evidence |

Folder management means adding and removing library locations. Creating, renaming, moving, or deleting physical folders is not part of v1. Removing a library location must leave its originals untouched.

HEIC, RAW, photo editing, face recognition, maps, phone backup, and duplicate merging remain later decisions.

## Following media types

### 2. Music

Add a real audio-only playback plan and library metadata for artists, album artists, albums, discs, and tracks. Deliver browsing, queue controls, playlists, shuffle/repeat, and artwork. Define behavior when video starts while music is playing. Gapless playback, lyrics, ReplayGain, and casting are later capabilities with separate evidence.

### 3. Audiobooks

Reuse the proven audio transport. Start with one M4B, then ordered multipart books. Add authors, narrators, chapters, speed, sleep timer, bookmarks, and persistent resume. Audiobook progress is independent of music queue state and existing video progress. Define source identity and grouping rules before indexing multipart books.

### 4. Books

Start with DRM-free reflowable EPUB and PDF. Add a reader, contents navigation, reading settings, bookmarks, and source-versioned reading positions. Publication resources must remain authorized. Disable publication scripts and external resource loading. Defer DRM, annotation sync, text-to-speech, and complex fixed-layout EPUB.

### 5. Comics and manga

Start with CBZ, then PDF. Add series/volume/issue metadata, deterministic page ordering, fit-page and fit-width views, continuous scrolling, reading direction, and page resume. Bound archive extraction and prefetch only nearby pages. CBR follows a separate extractor and packaging decision.

## Completion rules

Each milestone must have matching storage, IPC contracts, interface behavior, permission checks, backup/reset handling, and documentation. Record static checks separately from runtime and visual evidence. Do not mark an entire media type complete because scanning or a placeholder page exists.

Keep the current video routes, library identities, and progress unchanged. Update this plan and the public roadmap as each usable workflow lands.
