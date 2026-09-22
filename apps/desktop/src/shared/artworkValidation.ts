export const ARTWORK_FORMAT_LABEL = 'JPG, PNG, WebP, GIF, BMP, or AVIF';
export const ARTWORK_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif';

export const MAX_ARTWORK_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARTWORK_IMPORT_COUNT = 512;
export const MAX_ARTWORK_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_ARTWORK_WIDTH = 8_192;
export const MAX_ARTWORK_HEIGHT = 8_192;
export const MAX_ARTWORK_PIXELS = 25_000_000;

export const SUPPORTED_ARTWORK_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
] as const;

export type SupportedArtworkMimeType = typeof SUPPORTED_ARTWORK_MIME_TYPES[number];

export const ARTWORK_STORAGE_TARGETS = ['thumbnail', 'poster', 'cover', 'logo'] as const;
export type ArtworkStorageTarget = typeof ARTWORK_STORAGE_TARGETS[number];

export type ArtworkValidationResult =
  | { ok: true; mimeType?: SupportedArtworkMimeType; decodedBytes?: number }
  | { ok: false; message: string };

const supportedMimeTypes = new Set<string>(SUPPORTED_ARTWORK_MIME_TYPES);
const mimeTypeByExtension: Record<string, SupportedArtworkMimeType> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function normalizeMimeType(value: string): string {
  const mimeType = value.toLowerCase().split(';', 1)[0].trim();
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
}

export function artworkMimeTypeForFile(file: { name?: string; type?: string }): SupportedArtworkMimeType | null {
  const declaredType = normalizeMimeType(file.type || '');
  if (supportedMimeTypes.has(declaredType)) return declaredType as SupportedArtworkMimeType;
  if (declaredType && declaredType !== 'application/octet-stream') return null;

  const name = (file.name || '').toLowerCase();
  const extension = name.slice(name.lastIndexOf('.'));
  return mimeTypeByExtension[extension] || null;
}

export function validateArtworkDimensions(width: number, height: number): ArtworkValidationResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return { ok: false, message: 'The selected artwork has invalid dimensions.' };
  }
  if (width > MAX_ARTWORK_WIDTH || height > MAX_ARTWORK_HEIGHT || width * height > MAX_ARTWORK_PIXELS) {
    return {
      ok: false,
      message: `That artwork is too large to process. Use an image no larger than ${MAX_ARTWORK_WIDTH} x ${MAX_ARTWORK_HEIGHT} pixels and ${MAX_ARTWORK_PIXELS.toLocaleString()} total pixels.`,
    };
  }
  return { ok: true };
}

export function isArtworkStorageTarget(value: unknown): value is ArtworkStorageTarget {
  return typeof value === 'string' && (ARTWORK_STORAGE_TARGETS as readonly string[]).includes(value);
}

export function assertArtworkStorageTarget(value: unknown): asserts value is ArtworkStorageTarget {
  if (!isArtworkStorageTarget(value)) {
    throw new Error('Unsupported artwork target. Use thumbnail, poster, cover, or logo.');
  }
}

