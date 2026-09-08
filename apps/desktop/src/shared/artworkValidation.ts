export const ARTWORK_FORMAT_LABEL = 'JPG, PNG, WebP, GIF, BMP, or AVIF';
export const ARTWORK_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif';

export const MAX_ARTWORK_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARTWORK_DATA_URL_BYTES = 16 * 1024 * 1024;
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

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function artworkMimeTypeForFile(file: { name?: string; type?: string }): SupportedArtworkMimeType | null {
  const declaredType = normalizeMimeType(file.type || '');
  if (supportedMimeTypes.has(declaredType)) return declaredType as SupportedArtworkMimeType;
  if (declaredType && declaredType !== 'application/octet-stream') return null;

  const name = (file.name || '').toLowerCase();
  const extension = name.slice(name.lastIndexOf('.'));
  return mimeTypeByExtension[extension] || null;
}

export function validateArtworkFile(file: { name?: string; type?: string; size?: number }): ArtworkValidationResult {
  const mimeType = artworkMimeTypeForFile(file);
  if (!mimeType) {
    return { ok: false, message: `Unsupported artwork format. Choose a ${ARTWORK_FORMAT_LABEL} image.` };
  }

  if (!Number.isFinite(file.size) || (file.size || 0) < 0) {
    return { ok: false, message: 'The selected artwork file has an invalid size.' };
  }
  if ((file.size || 0) > MAX_ARTWORK_FILE_BYTES) {
    return { ok: false, message: `That artwork file is larger than ${formatMegabytes(MAX_ARTWORK_FILE_BYTES)}. Choose a smaller image.` };
  }

  return { ok: true, mimeType, decodedBytes: file.size || 0 };
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

function decodedBase64ByteLength(value: string): number | null {
  const encoded = value.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = (encoded.length * 3) / 4 - padding;
  return Number.isSafeInteger(decodedBytes) && decodedBytes > 0 ? decodedBytes : null;
}

export function validateArtworkValue(value: unknown, maxDecodedBytes = MAX_ARTWORK_DATA_URL_BYTES): ArtworkValidationResult {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, message: 'Artwork data is empty.' };
  }

  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('data:')) return { ok: true };

  const comma = trimmed.indexOf(',');
  if (comma < 0) {
    return { ok: false, message: `Artwork data must be a base64 ${ARTWORK_FORMAT_LABEL} image.` };
  }

  const metadata = trimmed.slice(5, comma).split(';');
  const mimeType = normalizeMimeType(metadata.shift() || '');
  if (!supportedMimeTypes.has(mimeType)) {
    return { ok: false, message: `Unsupported artwork format. Use a ${ARTWORK_FORMAT_LABEL} image.` };
  }
  if (!metadata.some((part) => part.trim().toLowerCase() === 'base64')) {
    return { ok: false, message: `Artwork data must be base64 encoded as a ${ARTWORK_FORMAT_LABEL} image.` };
  }

  const decodedBytes = decodedBase64ByteLength(trimmed.slice(comma + 1));
  if (decodedBytes === null) {
    return { ok: false, message: 'Artwork data is not valid base64.' };
  }
  if (decodedBytes > maxDecodedBytes) {
    return { ok: false, message: `That artwork is larger than ${formatMegabytes(maxDecodedBytes)} after decoding. Choose a smaller image.` };
  }

  return { ok: true, mimeType: mimeType as SupportedArtworkMimeType, decodedBytes };
}
