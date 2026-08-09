import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const MAX_ARTWORK_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTWORK_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTWORK_DIMENSION = 8_192;
export const MAX_ARTWORK_PIXELS = 32_000_000;
export const MAX_ARTWORK_FRAMES = 1;

export type ArtworkFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export type ArtworkInspection = {
  format: ArtworkFormat;
  width: number;
  height: number;
  frames: number;
  hasMetadata: boolean;
};

export type SanitizedArtwork = {
  bytes: Buffer;
  mimeType: 'image/png';
  byteLength: number;
  contentHash: string;
  width: number;
  height: number;
  frames: 1;
};

export type ArtworkDecoder = {
  createFromBuffer: (buffer: Buffer) => {
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    toPNG: () => Buffer;
  };
};

function rejectArtwork(message: string): never {
  throw new Error(`Artwork rejected: ${message}`);
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) rejectArtwork('invalid dimensions');
  if (width > MAX_ARTWORK_DIMENSION || height > MAX_ARTWORK_DIMENSION) rejectArtwork('dimensions exceed the host limit');
  if (width * height > MAX_ARTWORK_PIXELS) rejectArtwork('pixel count exceeds the host limit');
}

function readPng(bytes: Buffer): ArtworkInspection {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) rejectArtwork('PNG signature mismatch');
  if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') rejectArtwork('PNG header is incomplete');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 8;
  let frames = 1;
  let hasMetadata = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) rejectArtwork('PNG chunk exceeds the input');
    if (type === 'acTL') {
      if (length < 8) rejectArtwork('PNG animation header is malformed');
      frames = bytes.readUInt32BE(offset + 8);
    }
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt' || type === 'eXIf') hasMetadata = true;
    if (type === 'IEND') { ended = true; break; }
    offset = end;
  }
  if (!ended) rejectArtwork('PNG is missing IEND');
  checkDimensions(width, height);
  if (frames > MAX_ARTWORK_FRAMES) rejectArtwork('animated artwork is not supported');
  return { format: 'png', width, height, frames, hasMetadata };
}

function readJpeg(bytes: Buffer): ArtworkInspection {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) rejectArtwork('JPEG signature mismatch');
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) rejectArtwork('JPEG segment is incomplete');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) rejectArtwork('JPEG segment exceeds the input');
    const isFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) {
      if (length < 7) rejectArtwork('JPEG frame header is malformed');
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      break;
    }
    offset += length;
  }
  checkDimensions(width, height);
  return { format: 'jpeg', width, height, frames: 1, hasMetadata: true };
}

function skipGifSubBlocks(bytes: Buffer, position: number): number {
  let offset = position;
  for (let count = 0; count < 256; count += 1) {
    if (offset >= bytes.length) rejectArtwork('GIF sub-block is incomplete');
    const length = bytes[offset++];
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) rejectArtwork('GIF sub-block exceeds the input');
  }
  rejectArtwork('GIF contains too many sub-blocks');
}

function readGif(bytes: Buffer): ArtworkInspection {
  if (bytes.length < 13 || (bytes.toString('ascii', 0, 6) !== 'GIF87a' && bytes.toString('ascii', 0, 6) !== 'GIF89a')) rejectArtwork('GIF signature mismatch');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (2 ** ((bytes[10] & 0x07) + 1));
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= bytes.length) rejectArtwork('GIF extension is incomplete');
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) rejectArtwork('GIF image descriptor is malformed');
    frames += 1;
    checkDimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset >= bytes.length) rejectArtwork('GIF image data is incomplete');
    offset += 1;
    offset = skipGifSubBlocks(bytes, offset);
    if (frames > MAX_ARTWORK_FRAMES) rejectArtwork('animated artwork is not supported');
  }
  checkDimensions(width, height);
  if (frames < 1) rejectArtwork('GIF contains no image frame');
  return { format: 'gif', width, height, frames, hasMetadata: true };
}

function readWebp(bytes: Buffer): ArtworkInspection {
  if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') rejectArtwork('WebP signature mismatch');
  let offset = 12;
  let width = 0;
  let height = 0;
  let frames = 1;
  let hasMetadata = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > bytes.length) rejectArtwork('WebP chunk exceeds the input');
    if (type === 'VP8X' && length >= 10) {
      width = 1 + bytes.readUIntLE(data + 4, 3);
      height = 1 + bytes.readUIntLE(data + 7, 3);
      if (bytes[data] & 0x02) frames = 2;
    } else if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
      width = 1 + (bytes[data + 1] | ((bytes[data + 2] & 0x3f) << 8));
      height = 1 + ((bytes[data + 2] >> 6) | (bytes[data + 3] << 2) | ((bytes[data + 4] & 0x0f) << 10));
    } else if (type === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      width = bytes.readUInt16LE(data + 6) & 0x3fff;
      height = bytes.readUInt16LE(data + 8) & 0x3fff;
    } else if (type === 'ANIM') {
      frames = 2;
    } else if (type === 'EXIF' || type === 'XMP ') {
      hasMetadata = true;
    }
    offset = data + length + (length % 2);
  }
  checkDimensions(width, height);
  if (frames > MAX_ARTWORK_FRAMES) rejectArtwork('animated artwork is not supported');
  return { format: 'webp', width, height, frames, hasMetadata };
}

export function inspectArtworkBytes(bytes: Buffer, contentType = ''): ArtworkInspection {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARTWORK_INPUT_BYTES) rejectArtwork('input size is invalid');
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mime === 'image/svg+xml' || mime === 'image/svg') rejectArtwork('SVG artwork is not supported');
  const inspection = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? readPng(bytes)
    : bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
      ? readJpeg(bytes)
      : bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a'
        ? readGif(bytes)
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? readWebp(bytes)
          : null;
  if (!inspection) rejectArtwork('unsupported or mismatched image signature');
  const expectedFormats: Record<string, ArtworkFormat> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  if (mime.startsWith('image/') && !expectedFormats[mime]) rejectArtwork('unsupported image content type');
  if (mime && expectedFormats[mime] && expectedFormats[mime] !== inspection.format) {
    rejectArtwork('content type does not match the image signature');
  }
  return inspection;
}

export function sanitizeArtworkBytesWithDecoder(bytes: Buffer, contentType: string, decoder: ArtworkDecoder): SanitizedArtwork {
  const inspection = inspectArtworkBytes(bytes, contentType);
  const decoded = decoder.createFromBuffer(bytes);
  if (decoded.isEmpty()) rejectArtwork('image decoder returned an empty image');
  const size = decoded.getSize();
  checkDimensions(size.width, size.height);
  if (inspection.width !== size.width || inspection.height !== size.height) rejectArtwork('encoded and decoded dimensions differ');
  const normalized = decoded.toPNG();
  if (!Buffer.isBuffer(normalized) || normalized.length === 0 || normalized.length > MAX_ARTWORK_OUTPUT_BYTES) rejectArtwork('normalized image size is invalid');
  const hash = createHash('sha256').update(normalized).digest('hex');
  return {
    bytes: normalized,
    mimeType: 'image/png',
    byteLength: normalized.byteLength,
    contentHash: hash,
    width: size.width,
    height: size.height,
    frames: 1,
  };
}

const ARTWORK_WORKER_TIMEOUT_MS = 5_000;
const ARTWORK_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { nativeImage } = require('electron');
  const fail = (message) => parentPort.postMessage({ ok: false, error: message });
  try {
    const input = Buffer.from(workerData.bytes);
    const decoded = nativeImage.createFromBuffer(input);
    if (decoded.isEmpty()) throw new Error('image decoder returned an empty image');
    const size = decoded.getSize();
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
      || size.width <= 0 || size.height <= 0
      || size.width > workerData.maxDimension || size.height > workerData.maxDimension
      || size.width * size.height > workerData.maxPixels) {
      throw new Error('decoded dimensions exceed the host limit');
    }
    if (size.width !== workerData.expectedWidth || size.height !== workerData.expectedHeight) {
      throw new Error('encoded and decoded dimensions differ');
    }
    const normalized = decoded.toPNG();
    if (!Buffer.isBuffer(normalized) || normalized.length === 0 || normalized.length > workerData.maxOutputBytes) {
      throw new Error('normalized image size is invalid');
    }
    const output = Uint8Array.from(normalized);
    parentPort.postMessage({ ok: true, bytes: output, width: size.width, height: size.height }, [output.buffer]);
  } catch (error) {
    fail('worker decoder: ' + (error instanceof Error ? error.message : 'image decoder failed'));
  }
`;

/**
 * Decode and normalize untrusted artwork outside Electron's main event loop.
 * The worker has a bounded V8 heap, the encoded and decoded sizes are bounded,
 * and a timeout terminates the worker instead of leaving a wedged decoder in
 * the long-lived host process.
 */
export async function sanitizeArtworkBytes(bytes: Buffer, contentType = ''): Promise<SanitizedArtwork> {
  const inspection = inspectArtworkBytes(bytes, contentType);
  const input = Uint8Array.from(bytes);
  return new Promise<SanitizedArtwork>((resolve, reject) => {
    const worker = new Worker(ARTWORK_WORKER_SOURCE, {
      eval: true,
      workerData: {
        bytes: input,
        expectedWidth: inspection.width,
        expectedHeight: inspection.height,
        maxDimension: MAX_ARTWORK_DIMENSION,
        maxPixels: MAX_ARTWORK_PIXELS,
        maxOutputBytes: MAX_ARTWORK_OUTPUT_BYTES,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
      void worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Artwork rejected: decoder exceeded the time limit')));
    }, ARTWORK_WORKER_TIMEOUT_MS);
    worker.once('message', (message: unknown) => {
      const result = message && typeof message === 'object' ? message as Record<string, unknown> : {};
      if (result.ok !== true || !(result.bytes instanceof Uint8Array)) {
        finish(() => reject(new Error(`Artwork rejected: ${String(result.error || 'image decoder failed')}`)));
        return;
      }
      const normalized = Buffer.from(result.bytes);
      if (normalized.length === 0 || normalized.length > MAX_ARTWORK_OUTPUT_BYTES) {
        finish(() => reject(new Error('Artwork rejected: normalized image size is invalid')));
        return;
      }
      const hash = createHash('sha256').update(normalized).digest('hex');
      finish(() => resolve({
        bytes: normalized,
        mimeType: 'image/png',
        byteLength: normalized.byteLength,
        contentHash: hash,
        width: Number(result.width),
        height: Number(result.height),
        frames: 1,
      }));
    });
    worker.once('error', (error) => finish(() => reject(new Error(`Artwork rejected: ${error.message}`))));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error('Artwork rejected: decoder process exited unexpectedly')));
    });
  });
}

const negativeArtworkCache = new Map<string, number>();
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_LIMIT = 512;

export function artworkNegativeCacheAllows(sourceUrl: string, now = Date.now()): boolean {
  const expiresAt = negativeArtworkCache.get(sourceUrl);
  if (expiresAt === undefined) return true;
  if (expiresAt <= now) {
    negativeArtworkCache.delete(sourceUrl);
    return true;
  }
  return false;
}

export function rememberArtworkFailure(sourceUrl: string, now = Date.now()): void {
  if (negativeArtworkCache.size >= NEGATIVE_CACHE_LIMIT && !negativeArtworkCache.has(sourceUrl)) {
    const oldest = negativeArtworkCache.keys().next().value;
    if (oldest) negativeArtworkCache.delete(oldest);
  }
  negativeArtworkCache.delete(sourceUrl);
  negativeArtworkCache.set(sourceUrl, now + NEGATIVE_CACHE_TTL_MS);
}

export function rememberArtworkSuccess(sourceUrl: string): void {
  negativeArtworkCache.delete(sourceUrl);
}
