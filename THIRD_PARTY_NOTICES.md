# LoomTV third-party notices

LoomTV source code remains available under the MIT License in `LICENSE`.
These notices identify third-party libraries, services, artwork, and native
runtime payloads. LoomTV-authored files retain their MIT license; distributing
them together with GPL-covered components can impose additional obligations
on the combined distribution. This inventory is not a grant of rights to
provider data or trademarks.

## Desktop application

The desktop application uses these direct runtime dependencies:

| Component | License | Source or notice |
| --- | --- | --- |
| Electron | MIT | <https://www.electronjs.org/> |
| Electron Forge | MIT | <https://www.electronforge.io/> |
| Electron Updater | MIT | <https://github.com/electron-userland/electron-builder> |
| React and React DOM | MIT | <https://react.dev/> |
| TanStack Router (`@tanstack/react-router`) | MIT | <https://tanstack.com/router> |
| TanStack Query and Virtual | MIT | <https://tanstack.com/> |
| WebTorrent | MIT | <https://github.com/webtorrent/webtorrent> |
| Sharp | Apache-2.0 | <https://sharp.pixelplumbing.com/>; libvips and its bundled dependencies retain separate licenses |
| Vite | MIT | <https://vite.dev/> |
| TypeScript | Apache-2.0 | <https://www.typescriptlang.org/> |
| Tailwind CSS and tailwind-merge | MIT | <https://tailwindcss.com/> and <https://github.com/dcastil/tailwind-merge> |
| PostCSS | MIT | <https://postcss.org/> |
| better-sqlite3 | MIT | <https://github.com/WiseLibs/better-sqlite3> |
| bonjour-service | MIT | <https://github.com/onlxltd/bonjour-service> |
| clsx | MIT | <https://github.com/lukeed/clsx> |
| hls.js | Apache-2.0 | <https://github.com/video-dev/hls.js> |
| Koffi | MIT | <https://github.com/Koromix/koffi> |
| Lucide React | ISC, with MIT notices for Feather-derived icons | <https://lucide.dev/license> |
| Motion | MIT | <https://motion.dev/> |
| Phosphor Icons React | MIT | <https://phosphoricons.com/> |
| Zod | MIT | <https://github.com/colinhacks/zod> |
| electron-squirrel-startup | Apache-2.0 | <https://github.com/mongodb-js/electron-squirrel-startup> |

The application also includes component patterns inspired by shadcn/ui,
licensed under the MIT License: <https://ui.shadcn.com/>.

Local license-text snapshots for direct desktop runtime dependencies are in
`apps/desktop/resources/licenses/`. The inventory there records the installed
versions and files copied. These snapshots do not replace the transitive and
native-component inventory required for a release.

The Stremio official add-on registry is copyright 2019 SmartCode OOD and is
MIT licensed. Its license is included in
`apps/desktop/resources/licenses/stremio-official-addons.LICENSE.md`.
That source-code license does not grant unrestricted rights to Stremio-hosted
services, subtitle files, movie metadata, artwork or third-party brands.

## Bundled native runtimes

Native payloads keep their upstream licenses and notices. LoomTV's MIT
license does not replace those terms.

- **LibVLC / VLC:** LibVLC and libvlccore are generally LGPL-2.1-or-later.
  VLC plugins and bundled dependencies may carry different terms. See
  `apps/desktop/resources/libvlc/NOTICE.md` and the upstream VideoLAN legal
  notices at <https://www.videolan.org/legal.html>.
- **mpv:** macOS arm64 builds bundle Homebrew's libmpv 0.41.0 with its 46
  dependency libraries, including GPL-2.0-or-later x264 and x265 through
  FFmpeg. The bundle is GPL-covered. See
  `apps/desktop/resources/mpv/NOTICE.md` for the per-library inventory and
  <https://github.com/mpv-player/mpv>.
- **Download source:** Builds fetch FFmpeg, LibVLC, and libmpv from the
  `runtimes-2026-09` GitHub release on this repository and check each archive
  against the SHA-256 in `apps/desktop/native-runtimes.json`.
- **FFmpeg and FFprobe:** The bundled builds include GPL components and are
  distributed under GPL-3.0-or-later as applicable to the build and included
  libraries. Keep the matching license text and source information from
  `apps/desktop/resources/ffmpeg/NOTICE.md`,
  `apps/desktop/resources/ffmpeg/COPYING.GPLv3.txt`, and the Windows license
  file with distributed packages.
- **fpcalc / Chromaprint:** Chromaprint code is MIT licensed. The release can
  include additional linked components, so keep the upstream inventory listed
  in `apps/desktop/resources/fpcalc/NOTICE.md`.
- **DiceBear Glyphs:** Avatar artwork uses the DiceBear Glyphs style, a remix
  of Matt Houser's “Abstract Avatars for All Creative Profile Use,” under CC
  BY 4.0. See `apps/desktop/resources/DICEBEAR_GLYPHS_LICENSE.md`.

## Mobile application

The mobile application uses Expo and React Native packages under the MIT
License, including Expo, Expo Dev Client, Expo File System, Expo Image, Expo
SQLite, Expo Video, React, React Native, Zod, react-native-safe-area-context,
react-native-svg, and react-native-zeroconf. The complete mobile attribution
also appears in `apps/mobile/THIRD_PARTY_NOTICES.md`.

DiceBear Glyphs avatars in the mobile application are covered by the same CC
BY 4.0 attribution in `apps/mobile/DICEBEAR_GLYPHS_LICENSE.md`.

## TV application

The TV application uses the Expo, Expo Secure Store, Expo Status Bar, Expo
Video, React, React Native, react-native-safe-area-context, and
react-native-zeroconf packages. These packages are distributed under the MIT
License. The TV application shares the mobile secure transport module and its
own native dependency notices.

## Provider services

LoomTV can contact third-party metadata services for artwork, ratings, and
metadata when the user enables or uses those providers. Their data, API keys,
terms, attribution rules, rate limits, and privacy policies remain separate:

- TMDB: <https://www.themoviedb.org/>
- TVmaze: <https://www.tvmaze.com/>
- Jikan / MyAnimeList: <https://jikan.moe/>
- OMDb API: <https://www.omdbapi.com/>
- Fanart.tv: <https://fanart.tv/>
- AniList: <https://anilist.co/>
- TheTVDB: <https://thetvdb.com/>
- MDBList: <https://mdblist.com/> and <https://mdblist.com/static/legal.html>
- Cinemeta, WatchHub and OpenSubtitles v3, through Stremio:
  <https://github.com/Stremio/stremio-official-addons>
- TheIntroDB: <https://theintrodb.org/>
- AniSkip: <https://aniskip.com/>
- SkipDB: <https://skipdb.tv/>

This product uses the TMDB API but is not endorsed or certified by TMDB.
TMDB requires an approved logo and attribution in the application; commercial
use requires the applicable agreement. See <https://developer.themoviedb.org/docs/faq>.

Cinemeta and WatchHub are installed by default when metadata offline mode is
off, subject to existing installations and previous removal choices. Online
subtitle search and downloads use `opensubtitles-v3.strem.io` and Stremio's
subtitle delivery hosts on request. This is not a direct integration with the
OpenSubtitles.com REST API.

MDBList fills missing add-on ratings when OMDb is unavailable or has no score.
IMDb, Rotten Tomatoes and Metacritic are the original rating brands, not the
same entities as the API aggregators. An aggregator API response does not by
itself establish permission to redistribute branding or data. Rotten Tomatoes
publishes permission, attribution, linking and score-icon requirements at
<https://www.rottentomatoes.com/help_desk/licensing>.

The rating SVGs under `apps/desktop/src/assets/ratings/` are third-party brand
assets, not LoomTV artwork covered by the project's MIT license. Permission
and source records for these assets still need verification before release.

LoomTV is not affiliated with or endorsed by these providers.

## Review rule

When a dependency or bundled runtime changes, update its version, license,
source, and local notice together. Do not describe a third-party runtime as
MIT or LGPL merely because LoomTV's own source is MIT.
