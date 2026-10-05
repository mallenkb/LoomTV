import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker, type WorkerOptions } from 'node:worker_threads';

const MAX_ARTWORK_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_ARTWORK_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ARTWORK_DIMENSION = 8_192;
const MAX_ARTWORK_PIXELS = 32_000_000;
const MAX_ARTWORK_FRAMES = 1;

type ArtworkFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export type ArtworkInspection = {
  format: ArtworkFormat;
  width: number;
  height: number;
  frames: number;
  hasMetadata: boolean;
};

export type SanitizedArtwork = {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
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
    toJPEG: (quality: number) => Buffer;
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
  const normalizedMimeType: SanitizedArtwork['mimeType'] = inspection.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  let normalized = inspection.format === 'jpeg' ? decoded.toJPEG(88) : decoded.toPNG();
  if (inspection.format === 'jpeg' && Buffer.isBuffer(normalized) && normalized.length > MAX_ARTWORK_OUTPUT_BYTES) {
    for (const quality of [82, 72]) {
      const jpeg = decoded.toJPEG(quality);
      if (Buffer.isBuffer(jpeg) && jpeg.length > 0 && jpeg.length <= MAX_ARTWORK_OUTPUT_BYTES) {
        normalized = jpeg;
        break;
      }
    }
  }
  if (!Buffer.isBuffer(normalized) || normalized.length === 0 || normalized.length > MAX_ARTWORK_OUTPUT_BYTES) rejectArtwork('normalized image size is invalid');
  const hash = createHash('sha256').update(normalized).digest('hex');
  return {
    bytes: normalized,
    mimeType: normalizedMimeType,
    byteLength: normalized.byteLength,
    contentHash: hash,
    width: size.width,
    height: size.height,
    frames: 1,
  };
}

const ARTWORK_WORKER_TIMEOUT_MS = 5_000;
// Reserve decoded RGBA pixels across workers. One maximum-sized image uses the
// entire 128 MB budget; smaller images can decode alongside each other.
const MAX_ACTIVE_ARTWORK_DECODE_PIXELS = MAX_ARTWORK_PIXELS;
const MAX_QUEUED_ARTWORK_DECODES = 32;
let activeArtworkDecodePixels = 0;
const waitingArtworkDecodes: Array<{ pixels: number; start: () => void }> = [];

function startWaitingArtworkDecodes(): void {
  while (waitingArtworkDecodes.length > 0
    && activeArtworkDecodePixels + waitingArtworkDecodes[0].pixels <= MAX_ACTIVE_ARTWORK_DECODE_PIXELS) {
    waitingArtworkDecodes.shift()?.start();
  }
}

function runWithArtworkDecodeBudget<T>(pixels: number, task: () => Promise<T>): Promise<T> {
  if (waitingArtworkDecodes.length >= MAX_QUEUED_ARTWORK_DECODES) {
    return Promise.reject(new Error('Artwork rejected: decoder queue is full'));
  }
  return new Promise<T>((resolve, reject) => {
    waitingArtworkDecodes.push({
      pixels,
      start: () => {
        activeArtworkDecodePixels += pixels;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeArtworkDecodePixels -= pixels;
            startWaitingArtworkDecodes();
          });
      },
    });
    startWaitingArtworkDecodes();
  });
}

const artworkRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
let artworkFallbackLogged = false;

class ArtworkDecoderUnavailableError extends Error {}

export type ArtworkSanitizerOptions = {
  fallbackDecoder?: ArtworkDecoder;
  workerFactory?: (source: string, options: WorkerOptions) => Worker;
  warn?: (message: string) => void;
};

const ARTWORK_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    let sharp;
    try {
      sharp = require(workerData.decoderModulePath);
      sharp.cache(false);
      sharp.concurrency(1);
    } catch (error) {
      parentPort.postMessage({ unavailable: true, error: error.message });
      return;
    }
    parentPort.postMessage({ ready: true });
    await new Promise((resolve) => parentPort.once('message', resolve));
    const checkSize = (size) => {
      if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
        || size.width <= 0 || size.height <= 0
        || size.width > workerData.maxDimension || size.height > workerData.maxDimension
        || size.width * size.height > workerData.maxPixels) {
        throw new Error('decoded dimensions exceed the host limit');
      }
      if (size.width !== workerData.expectedWidth || size.height !== workerData.expectedHeight) {
        throw new Error('encoded and decoded dimensions differ');
      }
    };
    const input = Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength);
    const decoded = sharp(input, {
      failOn: 'warning',
      limitInputPixels: workerData.maxPixels,
      limitInputChannels: 4,
      sequentialRead: true,
      ignoreIcc: true,
      pages: 1,
    }).timeout({ seconds: 4 });
    checkSize(await decoded.metadata());
    const isJpeg = workerData.inputFormat === 'jpeg';
    const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
    let { data: normalized, info } = await (isJpeg ? decoded.clone().jpeg({ quality: 88 }) : decoded.clone().png()).toBuffer({ resolveWithObject: true });
    if (isJpeg && normalized.length > workerData.maxOutputBytes) {
      for (const quality of [82, 72]) {
        const jpeg = await decoded.clone().jpeg({ quality }).toBuffer({ resolveWithObject: true });
        if (jpeg.data.length > 0 && jpeg.data.length <= workerData.maxOutputBytes) {
          normalized = jpeg.data;
          info = jpeg.info;
          break;
        }
      }
    }
    checkSize(info);
    if (normalized.length === 0 || normalized.length > workerData.maxOutputBytes) {
      throw new Error('normalized image size is invalid');
    }
    const output = Uint8Array.from(normalized);
    parentPort.postMessage({ ok: true, bytes: output, mimeType, width: info.width, height: info.height }, [output.buffer]);
  })().catch((error) => parentPort.postMessage({ ok: false, error: error.message }));
`;

function decodeArtworkInWorker(bytes: Buffer, inspection: ArtworkInspection, options: ArtworkSanitizerOptions): Promise<SanitizedArtwork> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      const input = Uint8Array.from(bytes);
      worker = (options.workerFactory ?? ((source, settings) => new Worker(source, settings)))(ARTWORK_WORKER_SOURCE, {
        eval: true,
        workerData: {
          bytes: input,
          decoderModulePath: artworkRequire.resolve('sharp'),
          expectedWidth: inspection.width,
          expectedHeight: inspection.height,
          inputFormat: inspection.format,
          maxDimension: MAX_ARTWORK_DIMENSION,
          maxPixels: MAX_ARTWORK_PIXELS,
          maxOutputBytes: MAX_ARTWORK_OUTPUT_BYTES,
        },
        transferList: [input.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          codeRangeSizeMb: 16,
          stackSizeMb: 4,
        },
      });
    } catch (error) {
      reject(new ArtworkDecoderUnavailableError(`decoder could not start: ${String(error)}`));
      return;
    }
    let ready = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Keep the pixel reservation and fetch slot until decode memory is gone.
      void worker.terminate().then(callback, (error: unknown) => {
        reject(new Error(`Artwork rejected: decoder termination failed: ${String(error)}`));
      });
    };
    const timeout = setTimeout(() => {
      finish(() => reject(ready
        ? new Error('Artwork rejected: decoder exceeded the time limit')
        : new ArtworkDecoderUnavailableError('decoder did not start within the time limit')));
    }, ARTWORK_WORKER_TIMEOUT_MS);
    worker.on('message', (message: unknown) => {
      if (settled) return;
      const result = message && typeof message === 'object' ? message as Record<string, unknown> : {};
      if (result.ready === true) {
        ready = true;
        try { worker.postMessage({ decode: true }); } catch (error) {
          finish(() => reject(error));
        }
        return;
      }
      if (!ready && result.unavailable === true) {
        finish(() => reject(new ArtworkDecoderUnavailableError(`decoder could not initialize: ${String(result.error)}`)));
        return;
      }
      if (!ready || result.ok !== true || !(result.bytes instanceof Uint8Array)) {
        finish(() => reject(new Error(`Artwork rejected: ${String(result.error || 'image decoder failed')}`)));
        return;
      }
      try {
        const normalized = Buffer.from(result.bytes);
        if (normalized.length === 0 || normalized.length > MAX_ARTWORK_OUTPUT_BYTES) rejectArtwork('normalized image size is invalid');
        if (result.mimeType !== 'image/png' && result.mimeType !== 'image/jpeg') rejectArtwork('normalized image content type is invalid');
        const output = inspectArtworkBytes(normalized, result.mimeType);
        if (output.width !== inspection.width || output.height !== inspection.height
          || result.width !== output.width || result.height !== output.height) rejectArtwork('encoded and decoded dimensions differ');
        const hash = createHash('sha256').update(normalized).digest('hex');
        finish(() => resolve({
          bytes: normalized,
          mimeType: result.mimeType as SanitizedArtwork['mimeType'],
          byteLength: normalized.byteLength,
          contentHash: hash,
          width: output.width,
          height: output.height,
          frames: 1,
        }));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    worker.once('error', (error) => finish(() => reject(ready
      ? new Error(`Artwork rejected: ${error.message}`)
      : new ArtworkDecoderUnavailableError(`decoder could not initialize: ${error.message}`))));
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(ready
        ? new Error(`Artwork rejected: decoder exited without a result (${code})`)
        : new ArtworkDecoderUnavailableError(`decoder exited before initialization (${code})`));
    });
  });
}

/** Decode untrusted artwork with bounded input, pixels, worker heap, and time. */
export async function sanitizeArtworkBytes(bytes: Buffer, contentType = '', options: ArtworkSanitizerOptions = {}): Promise<SanitizedArtwork> {
  const inspection = inspectArtworkBytes(bytes, contentType);
  return runWithArtworkDecodeBudget(inspection.width * inspection.height, async () => {
    try {
      return await decodeArtworkInWorker(bytes, inspection, options);
    } catch (error) {
      if (!(error instanceof ArtworkDecoderUnavailableError) || !options.fallbackDecoder) throw error;
      if (!artworkFallbackLogged) {
        artworkFallbackLogged = true;
        (options.warn ?? console.warn)(`[artwork] Off-thread decoder unavailable; using main-thread nativeImage fallback. ${error.message}`);
      }
      return sanitizeArtworkBytesWithDecoder(bytes, contentType, options.fallbackDecoder);
    }
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
