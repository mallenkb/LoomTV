import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import type { LibraryData } from '../src/main/appContracts.ts';
import { loadLibrary, saveLibrary } from '../src/main/databaseLibraryRepository.ts';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import {
  getAllProgress,
  getPlaybackTrackPreferences,
  importProgress,
  loadSettings,
  savePlaybackTrackPreferences,
  saveProgress,
  saveSettings,
} from '../src/main/databasePlaybackRepository.ts';
import {
  createProfile,
  createGuestProfile,
  deleteProfile,
  getDeviceSelectionRevision,
  getDeviceProfileSelection,
  getProfileLists,
  getProfilePreferences,
  getProfileRestrictions,
  getOwnerProfile,
  resetOwnerProfile,
  saveProfilePreferences,
  saveProfileRestrictions,
  selectDeviceProfile,
  setProfileListEntry,
} from '../src/main/databaseProfilesRepository.ts';

function createDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  migrateDatabase(database);
  return database;
}

function library(): LibraryData {
  return {
    movies: [],
    animeShows: [],
    tvShows: [{
      id: 'show',
      type: 'tv',
      title: 'Show',
      year: 2026,
      poster: 'poster.jpg',
      backdrop: 'data:image/png;base64,inline',
      logo: 'logo.png',
      posterCandidates: ['poster.jpg', 'poster.jpg'],
      backdropCandidates: ['data:image/png;base64,inline'],
      logoCandidates: ['logo.png'],
      summary: 'Summary',
      rating: 8,
      genres: ['Drama'],
      cast: [{ name: 'Actor', character: 'Lead', image: '' }],
      filePath: '/library/show',
      seasons: [
        { number: 2, title: 'Season 2', episodeCount: 1 },
        { number: 1, title: 'Season 1', episodeCount: 2 },
      ],
      episodes: [
        { season: 2, number: 1, title: 'Later', summary: '', still: '', rating: 0, airDate: '' },
        { season: 1, number: 2, title: 'Second', summary: '', still: '', rating: 0, airDate: '' },
        { season: 1, number: 1, title: 'Pilot', summary: '', still: '', rating: 0, airDate: '' },
      ],
      episodeFiles: [
        { season: 2, episode: 1, filePath: '/library/show.s02e01.mkv' },
        { season: 1, episode: 2, filePath: '/library/show.s01e02.mkv' },
        { season: 1, episode: 1, filePath: '/library/show.s01e01.mkv' },
      ],
    }],
    libraryFolders: ['/library'],
    libraryFolderGroups: { movies: [], tvShows: ['/library'], anime: [], others: [] },
    scanCache: {
      '/library': {
        version: 9,
        folderKind: 'tv',
        signature: 'signature',
        subtitleProfile: 'en',
        fileCount: 3,
        itemCount: 1,
        scannedAt: 42,
      },
    },
  };
}

test('library repository round-trips the existing schema, ordering, and durable overlays', () => {
  const database = createDatabase();
  try {
    saveLibrary(database, library());
    const result = loadLibrary(
      database,
      new Map([
        ['/library/show.s01e01.mkv', { position: 10, duration: 100, updatedAt: 100, watched: false }],
        ['/library/show.s02e01.mkv', { position: 20, duration: 100, updatedAt: 200, watched: false }],
      ]),
      new Map([['show', new Map([['poster', 'data:image/png;base64,custom']])]]),
    );

    assert.ok(result);
    assert.deepEqual(result.libraryFolderGroups, { movies: [], tvShows: ['/library'], anime: [], others: [] });
    assert.deepEqual(result.tvShows[0].seasons?.map((season) => season.number), [1, 2]);
    assert.deepEqual(result.tvShows[0].episodes?.map((episode) => `${episode.season}-${episode.number}`), ['1-1', '1-2', '2-1']);
    assert.deepEqual(result.tvShows[0].episodeFiles?.map((episode) => `${episode.season}-${episode.episode}`), ['1-1', '1-2', '2-1']);
    assert.equal(result.tvShows[0].backdrop, '');
    assert.deepEqual(result.tvShows[0].posterCandidates, ['loomtv-custom-artwork://artwork/show/poster', 'poster.jpg']);
    assert.equal(result.tvShows[0].lastPlayed, undefined);
    assert.equal(result.scanCache?.['/library'].subtitleProfile, 'en');
  } finally {
    database.close();
  }
});

test('settings, progress, and track preference repositories retain normalization and conflict behavior', () => {
  const database = createDatabase();
  try {
    saveSettings(database, { appThemeMode: 'dark', localNetworkSharingEnabled: true });
    assert.deepEqual(loadSettings(database), { appThemeMode: 'dark', localNetworkSharingEnabled: true });

    const owner = getOwnerProfile(database);
    assert.ok(owner, 'migration creates an Owner profile');
    const ownerId = owner.id;

    const watched = saveProgress(database, ownerId, '/library/movie.mkv', 95, 100);
    assert.equal(watched.position, 100);
    assert.equal(watched.watched, true);
    importProgress(database, ownerId, {
      '/library/movie.mkv': { position: 10, duration: 100, updatedAt: watched.updatedAt - 1 },
      '/library/new.mkv': { position: 20, duration: 100, updatedAt: watched.updatedAt + 1 },
    });
    assert.equal(getAllProgress(database, ownerId)['/library/movie.mkv'].position, 100);
    assert.equal(getAllProgress(database, ownerId)['/library/new.mkv'].position, 20);

    assert.deepEqual(savePlaybackTrackPreferences(database, ownerId, 'show', {
      audio: { enabled: true, language: ' EN ', codec: ' AAC ' },
      subtitle: { enabled: false, forced: true },
    }), {
      audio: { enabled: true, language: 'en', codec: 'aac' },
      subtitle: { enabled: false, forced: true },
    });
    assert.deepEqual(getPlaybackTrackPreferences(database, ownerId, 'show'), {
      audio: { enabled: true, language: 'en', codec: 'aac' },
      subtitle: { enabled: false, forced: true },
    });
  } finally {
    database.close();
  }
});

test('profiles keep viewer state isolated and cascade on delete', () => {
  const database = createDatabase();
  try {
    const owner = getOwnerProfile(database);
    assert.ok(owner);
    const second = createProfile(database, { name: 'Amara', type: 'standard' });

    saveProgress(database, owner.id, '/library/movie.mkv', 30, 100);
    saveProgress(database, second.id, '/library/movie.mkv', 80, 100);
    assert.equal(getAllProgress(database, owner.id)['/library/movie.mkv'].position, 30);
    assert.equal(getAllProgress(database, second.id)['/library/movie.mkv'].position, 80);

    savePlaybackTrackPreferences(database, owner.id, 'show', { audio: { enabled: true, language: 'en' } });
    assert.deepEqual(getPlaybackTrackPreferences(database, second.id, 'show'), {});

    selectDeviceProfile(database, 'tablet-1', second.id);
    assert.equal(getDeviceProfileSelection(database, 'tablet-1'), second.id);
    const revisionBeforeDelete = getDeviceSelectionRevision(database, 'tablet-1');

    assert.throws(() => deleteProfile(database, owner.id), /Owner profile cannot be deleted/);
    deleteProfile(database, second.id);
    assert.deepEqual(getAllProgress(database, second.id), {});
    assert.equal(getDeviceProfileSelection(database, 'tablet-1'), null);
    assert.equal(getDeviceSelectionRevision(database, 'tablet-1'), revisionBeforeDelete + 1);
    assert.equal(getAllProgress(database, owner.id)['/library/movie.mkv'].position, 30);
  } finally {
    database.close();
  }
});

test('profile preferences, restrictions, lists, Guest state, and Owner reset remain isolated', () => {
  const database = createDatabase();
  try {
    database.prepare("INSERT INTO library_folders (path, kind, added_at) VALUES ('/library', 'movies', 1)").run();
    const owner = getOwnerProfile(database);
    assert.ok(owner);
    const child = createProfile(database, { name: 'Child', type: 'kid' });

    saveProfilePreferences(database, child.id, { appThemeMode: 'light', playbackSkipForwardSeconds: 20 });
    saveProfileRestrictions(database, child.id, {
      country: 'US',
      maximumAge: 13,
      allowUnrated: false,
      allowedFolders: ['/library'],
    });
    setProfileListEntry(database, child.id, 'movie', 'favorite', true);
    assert.deepEqual(getProfilePreferences(database, owner.id), {});
    assert.equal(getProfilePreferences(database, child.id).playbackSkipForwardSeconds, 20);
    assert.deepEqual(getProfileRestrictions(database, child.id).allowedFolders, ['/library']);
    assert.equal(getProfileLists(database, child.id)[0].mediaId, 'movie');

    const guest = createGuestProfile(database, 'tablet-guest');
    assert.equal(guest.isGuest, true);
    assert.equal(getDeviceProfileSelection(database, 'tablet-guest'), guest.id);

    saveProgress(database, owner.id, '/library/owner.mkv', 10, 100);
    selectDeviceProfile(database, 'desktop-primary', owner.id);
    const replacement = resetOwnerProfile(database);
    assert.notEqual(replacement.id, owner.id);
    assert.equal(getAllProgress(database, owner.id)['/library/owner.mkv'], undefined);
    assert.equal(getDeviceProfileSelection(database, 'desktop-primary'), null);
    assert.equal(getOwnerProfile(database)?.id, replacement.id);
  } finally {
    database.close();
  }
});
