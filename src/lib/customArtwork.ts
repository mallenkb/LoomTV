import { desktopApi } from '@/lib/desktopApi';

const MOVIE_ARTWORK_KEY = 'loomtvCustomMovieArtwork';
const SHOW_ARTWORK_KEY = 'loomtvCustomShowArtwork';

type ArtworkById = Record<string, Record<string, string>>;

function readLegacy(key: string): ArtworkById {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}') as ArtworkById;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function isInlineArtworkSource(source: string): boolean {
  return /^data:image\//i.test(source);
}

function isRendererSafeArtworkSource(source: string): boolean {
  return isInlineArtworkSource(source) || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\//i.test(source.trim());
}

function rendererSafeArtwork(artwork: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(artwork).filter(([, value]) => isRendererSafeArtworkSource(value)),
  );
}

function inlineLegacyArtwork(artwork: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(artwork).filter(([, value]) => isInlineArtworkSource(value)),
  );
}

function writeLegacy(key: string, mediaId: string, targets: string[], valueByTarget: Record<string, string>): Record<string, string> {
  const legacy = readLegacy(key);
  legacy[mediaId] = {
    ...(legacy[mediaId] || {}),
    ...Object.fromEntries(targets.map((targetName) => [targetName, valueByTarget[targetName]]).filter((entry): entry is [string, string] => Boolean(entry[1]))),
  };
  try {
    localStorage.setItem(key, JSON.stringify(legacy));
  } catch {
    // The database save is the durable path.
  }
  return legacy[mediaId] || {};
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
  const legacy = inlineLegacyArtwork(readLegacy(legacyKey)[mediaId] || {});
  try {
    return rendererSafeArtwork(await desktopApi.getCustomArtwork(mediaId));
  } catch {
    return legacy;
  }
}

export async function saveCustomArtwork(mediaId: string, target: string, dataUrl: string, legacyKey: string): Promise<Record<string, string>> {
  const targets = target === 'thumbnail'
    ? ['thumbnail', 'poster']
    : target === 'poster'
      ? ['poster', 'thumbnail']
      : [target];

  try {
    let saved: Record<string, string> = {};
    for (const targetName of targets) {
      saved = await desktopApi.saveCustomArtwork(mediaId, targetName, dataUrl);
    }
    writeLegacy(legacyKey, mediaId, targets, {
      thumbnail: saved.thumbnail || saved.poster || dataUrl,
      poster: saved.poster || saved.thumbnail || dataUrl,
      cover: saved.cover || saved.backdrop || dataUrl,
      backdrop: saved.backdrop || saved.cover || dataUrl,
      [target]: saved[target] || dataUrl,
    });
    return saved;
  } catch {
    if (isInlineArtworkSource(dataUrl)) {
      return writeLegacy(legacyKey, mediaId, targets, Object.fromEntries(targets.map((targetName) => [targetName, dataUrl])));
    }
    throw new Error('Unable to cache artwork in the database.');
  }
}
