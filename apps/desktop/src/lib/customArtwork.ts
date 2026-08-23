import { desktopApi } from '@/lib/desktopApi';
import { parseStoredValue } from '@/lib/desktopDecoders';
import { z } from 'zod';

const MOVIE_ARTWORK_KEY = 'loomtvCustomMovieArtwork';
const SHOW_ARTWORK_KEY = 'loomtvCustomShowArtwork';

type ArtworkById = Record<string, Record<string, string>>;
const artworkByIdSchema = z.record(z.string(), z.record(z.string(), z.string()));

function readLegacy(key: string): ArtworkById {
  return parseStoredValue(localStorage.getItem(key), artworkByIdSchema, {});
}

export async function migrateLegacyArtwork(): Promise<void> {
  const movies = readLegacy(MOVIE_ARTWORK_KEY);
  const shows = readLegacy(SHOW_ARTWORK_KEY);
  const entries = { ...movies, ...shows };
  if (Object.keys(entries).length === 0) return;
  try {
    await desktopApi.importCustomArtwork(entries);
  } catch {
    // The localStorage copy remains as a fallback.
  }
}

export async function loadCustomArtwork(mediaId: string, legacyKey: string): Promise<Record<string, string>> {
  const legacy = readLegacy(legacyKey)[mediaId] || {};
  try {
    return { ...legacy, ...(await desktopApi.getCustomArtwork(mediaId)) };
  } catch {
    return legacy;
  }
}

export async function saveCustomArtwork(mediaId: string, target: string, dataUrl: string, legacyKey: string): Promise<Record<string, string>> {
  const legacy = readLegacy(legacyKey);
  const previousLegacy = legacy[mediaId] ? { ...legacy[mediaId] } : undefined;
  const targets = target === 'thumbnail'
    ? ['thumbnail', 'poster']
    : target === 'poster'
      ? ['poster', 'thumbnail']
      : [target];
  legacy[mediaId] = {
    ...(legacy[mediaId] || {}),
    ...Object.fromEntries(targets.map((targetName) => [targetName, dataUrl])),
  };
  try {
    localStorage.setItem(legacyKey, JSON.stringify(legacy));
  } catch {
    // The database save below is the durable path.
  }

  try {
    let saved: Record<string, string> = {};
    for (const targetName of targets) {
      saved = await desktopApi.saveCustomArtwork(mediaId, targetName, dataUrl);
    }
    return saved;
  } catch (error) {
    // localStorage is only a migration fallback. Returning it here made the
    // UI report a successful save even when the durable database write failed.
    // Surface the failure so the editor can show the user what went wrong.
    try {
      if (previousLegacy) legacy[mediaId] = previousLegacy;
      else delete legacy[mediaId];
      localStorage.setItem(legacyKey, JSON.stringify(legacy));
    } catch {
      // Keep the original persistence error as the user-facing failure.
    }
    throw error instanceof Error ? error : new Error('Unable to save artwork.');
  }
}
