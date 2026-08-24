# LoomTV third-party notices

LoomTV source code remains available under the MIT License in `LICENSE`.
These notices apply to third-party libraries, services, artwork, and native
runtime payloads. Their terms do not change the license for LoomTV source code.

## Desktop application

The desktop application uses these direct runtime dependencies:

| Component | License | Source or notice |
| --- | --- | --- |
| Electron | MIT | <https://www.electronjs.org/> |
| Electron Forge | MIT | <https://www.electronforge.io/> |
| Electron Updater | MIT | <https://github.com/electron-userland/electron-builder> |
| React and React DOM | MIT | <https://react.dev/> |
| React Router | MIT | <https://reactrouter.com/> |
| Vite | MIT | <https://vite.dev/> |
| TypeScript | Apache-2.0 | <https://www.typescriptlang.org/> |
| Tailwind CSS and tailwind-merge | MIT | <https://tailwindcss.com/> and <https://github.com/dcastil/tailwind-merge> |
| PostCSS | MIT | <https://postcss.org/> |
| better-sqlite3 | MIT | <https://github.com/WiseLibs/better-sqlite3> |
| bonjour-service | MIT | <https://github.com/onlxltd/bonjour-service> |
| clsx | MIT | <https://github.com/lukeed/clsx> |
| hls.js | Apache-2.0 | <https://github.com/video-dev/hls.js> |
| Koffi | MIT | <https://github.com/Koromix/koffi> |
| Lucide React | ISC | <https://lucide.dev/> |
| Motion | MIT | <https://motion.dev/> |
| Phosphor Icons React | MIT | <https://phosphoricons.com/> |
| Zod | MIT | <https://github.com/colinhacks/zod> |
| electron-squirrel-startup | Apache-2.0 | <https://github.com/mongodb-js/electron-squirrel-startup> |

The application also includes component patterns inspired by shadcn/ui,
licensed under the MIT License: <https://ui.shadcn.com/>.

## Bundled native runtimes

Native payloads keep their upstream licenses and notices. LoomTV's MIT
license does not replace those terms.

- **LibVLC / VLC:** LibVLC and libvlccore are generally LGPL-2.1-or-later.
  VLC plugins and bundled dependencies may carry different terms. See
  `apps/desktop/resources/libvlc/NOTICE.md` and the upstream VideoLAN legal
  notices at <https://www.videolan.org/legal.html>.
- **mpv:** Stock mpv is ordinarily GPL-2.0-or-later. The exact staged build
  and linked libraries must be reviewed with the upstream notices. See
  `apps/desktop/resources/mpv/NOTICE.md` and <https://github.com/mpv-player/mpv>.
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

LoomTV is not affiliated with or endorsed by these providers.

## Review rule

When a dependency or bundled runtime changes, update its version, license,
source, and local notice together. Do not describe a third-party runtime as
MIT or LGPL merely because LoomTV's own source is MIT.
