# Loom product structure

Loom is the name users see in the desktop app. Loom Media Server is the server component that runs locally, on another computer, or on a NAS.

```text
Loom
├── Home
├── Video
│   ├── Movies
│   ├── TV shows
│   ├── Anime
│   └── Other videos
├── Photos
│   ├── All photos
│   ├── Folders
│   ├── Albums
│   └── Favorites
├── Music
│   ├── Artists
│   ├── Albums
│   ├── Tracks
│   └── Playlists
├── Audiobooks
├── Books
├── Comics and manga
├── Live TV
├── Discover
└── Settings
```

Only implemented and configured sections should appear in navigation. The current Electron delivery order is Photos, Music, Audiobooks, Books, then Comics and manga. Tauri is outside this work.

A library has a name, a media type, and one or more source folders. Loom preserves the folder hierarchy on disk. Albums, playlists, and collections are database groupings and do not move original files.

Use media-specific actions. Users watch video, open photos, listen to music or audiobooks, and read books or comics. Progress follows the media type. Photos use folders, albums, favorites, and dates instead of watched state.

The rename keeps existing application IDs, data paths, database files, protocol identifiers, and update identity until a separate migration is designed. This lets existing LoomTV installations upgrade to Loom without moving user data.
