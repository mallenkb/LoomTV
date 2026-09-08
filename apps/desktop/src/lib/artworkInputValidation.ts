import {
  artworkMimeTypeForFile,
  assertArtworkStorageTarget,
  MAX_ARTWORK_FILE_BYTES,
  MAX_ARTWORK_IMPORT_BYTES,
  MAX_ARTWORK_IMPORT_COUNT,
  validateArtworkDimensions,
  type ArtworkStorageTarget,
  type ArtworkValidationResult,
  type SupportedArtworkMimeType,
} from '../shared/artworkValidation.ts';

export {
  assertArtworkStorageTarget,
  ARTWORK_FILE_ACCEPT,
  ARTWORK_FORMAT_LABEL,
  MAX_ARTWORK_FILE_BYTES,
  MAX_ARTWORK_IMPORT_BYTES,
  MAX_ARTWORK_IMPORT_COUNT,
  validateArtworkDimensions,
  type SupportedArtworkMimeType,
} from '../shared/artworkValidation.ts';

const MAX_URL_LENGTH = 8_192;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_RECORDS = 4_096;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const invalid = (message: string): ArtworkValidationResult => ({ ok: false, message });

export function validateArtworkFile(file: { name?: string; type?: string; size?: number }): ArtworkValidationResult {
  const mimeType = artworkMimeTypeForFile(file);
  if (!mimeType) return invalid('Choose a JPG, PNG, WebP, GIF, BMP, or AVIF image.');
  if (!Number.isSafeInteger(file.size) || !file.size || file.size < 0) return invalid('The artwork file is empty or has an invalid size.');
  if (file.size > MAX_ARTWORK_FILE_BYTES) return invalid('Choose an artwork file no larger than 16 MB.');
  return { ok: true, mimeType, decodedBytes: file.size };
}

// These structural checks run before a browser decoder sees local bytes. They
// do not validate compressed pixels or replace the postdecode dimension check.
// Reject animation and AVIF, whose coded frames/tiles need a bounded decoder.
export function validateArtworkBytes(bytes: Uint8Array, mimeType: SupportedArtworkMimeType): ArtworkValidationResult {
  if (!bytes.length || bytes.length > MAX_ARTWORK_FILE_BYTES) return invalid('Artwork must contain between 1 byte and 16 MB.');
  if (mimeType === 'image/avif') return invalid('Local AVIF artwork cannot be checked safely yet. Convert it to PNG or JPG first.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  const u16 = (at: number, le = false) => view.getUint16(at, le);
  const u32 = (at: number, le = false) => view.getUint32(at, le);
  const require = (condition: boolean) => { if (!condition) throw new Error('Artwork has a malformed or unsupported image header.'); };
  const dimensions = (width: number, height: number) => {
    const result = validateArtworkDimensions(width, height);
    if (!result.ok) throw new Error(result.message);
  };
  try {
    if (mimeType === 'image/png') {
      require(text(0, 8) === '\x89PNG\r\n\x1a\n' && bytes.length >= 33 && u32(8) === 13 && text(12, 4) === 'IHDR');
      dimensions(u32(16), u32(20));
      let at = 8;
      let hasData = false;
      let ended = false;
      for (let count = 0; at + 12 <= bytes.length && count < MAX_HEADER_RECORDS; count++) {
        const size = u32(at);
        const kind = text(at + 4, 4);
        require(size <= bytes.length - at - 12 && kind !== 'acTL' && kind !== 'fcTL' && kind !== 'fdAT');
        require(kind !== 'IHDR' || at === 8);
        if (kind === 'IDAT') hasData = true;
        at += size + 12;
        if (kind === 'IEND') { require(size === 0 && at === bytes.length); ended = true; break; }
      }
      require(hasData && ended);
    } else if (mimeType === 'image/jpeg') {
      require(u16(0) === 0xffd8);
      let at = 2;
      let found = false;
      while (at + 4 <= Math.min(bytes.length, MAX_HEADER_BYTES)) {
        require(bytes[at++] === 0xff);
        while (at < Math.min(bytes.length, MAX_HEADER_BYTES) && bytes[at] === 0xff) at++;
        const marker = bytes[at++];
        require(marker !== 0xda && marker !== 0xd9 && marker !== 0x00);
        const size = u16(at);
        require(size >= 2 && at + size <= Math.min(bytes.length, MAX_HEADER_BYTES));
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          require(size >= 8 && size === 8 + 3 * bytes[at + 7] && bytes[at + 2] === 8);
          dimensions(u16(at + 5), u16(at + 3));
          found = true;
          break;
        }
        at += size;
      }
      require(found);
    } else if (mimeType === 'image/gif') {
      require(bytes.length >= 13 && (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a'));
      const width = u16(6, true), height = u16(8, true);
      dimensions(width, height);
      let at = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
      let frames = 0, records = 0, ended = false;
      const skipBlocks = () => {
        while (at < bytes.length && records++ < MAX_HEADER_RECORDS) {
          const size = bytes[at++];
          if (!size) return;
          require(at + size <= bytes.length);
          at += size;
        }
        require(false);
      };
      while (at < bytes.length && records++ < MAX_HEADER_RECORDS) {
        const marker = bytes[at++];
        if (marker === 0x3b) { ended = true; break; }
        if (marker === 0x21) { require(at < bytes.length); at++; skipBlocks(); continue; }
        require(marker === 0x2c && at + 9 <= bytes.length && ++frames === 1);
        const frameWidth = u16(at + 4, true), frameHeight = u16(at + 6, true);
        dimensions(frameWidth, frameHeight);
        require(u16(at, true) + frameWidth <= width && u16(at + 2, true) + frameHeight <= height);
        const packed = bytes[at + 8];
        at += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        require(at < bytes.length && bytes[at] >= 2 && bytes[at] <= 8);
        at++;
        skipBlocks();
      }
      require(ended && frames === 1 && at === bytes.length);
    } else if (mimeType === 'image/webp') {
      require(bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && u32(4, true) === bytes.length - 8);
      let at = 12, frames = 0, canvas = false;
      for (let count = 0; at + 8 <= bytes.length && count < MAX_HEADER_RECORDS; count++) {
        const kind = text(at, 4), size = u32(at + 4, true), data = at + 8;
        require(size <= bytes.length - data && kind !== 'ANIM' && kind !== 'ANMF');
        if (kind === 'VP8X') {
          require(!canvas && at === 12 && size === 10 && !(bytes[data] & 2));
          const u24 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
          dimensions(1 + u24(data + 4), 1 + u24(data + 7));
          canvas = true;
        } else if (kind === 'VP8 ') {
          require(++frames === 1 && size >= 10 && !(bytes[data] & 1) && text(data + 3, 3) === '\x9d\x01\x2a');
          dimensions(u16(data + 6, true) & 0x3fff, u16(data + 8, true) & 0x3fff);
        } else if (kind === 'VP8L') {
          require(++frames === 1 && size >= 5 && bytes[data] === 0x2f);
          const bits = u32(data + 1, true);
          require((bits >>> 29) === 0);
          dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        at = data + size + (size % 2);
      }
      require(frames === 1 && at === bytes.length);
    } else if (mimeType === 'image/bmp') {
      require(bytes.length >= 54 && text(0, 2) === 'BM' && u32(2, true) === bytes.length);
      const dib = u32(14, true), offset = u32(10, true), bits = u16(28, true);
      require([40, 108, 124].includes(dib) && bytes.length >= 14 + dib && offset >= 14 + dib);
      require(u16(26, true) === 1 && (bits === 24 || bits === 32) && u32(30, true) === 0);
      const width = view.getInt32(18, true), height = Math.abs(view.getInt32(22, true));
      dimensions(width, height);
      require(offset + Math.ceil(width * bits / 32) * 4 * height <= bytes.length);
    } else {
      require(false);
    }
    return { ok: true, mimeType, decodedBytes: bytes.length };
  } catch (error) {
    return invalid(error instanceof RangeError ? 'The artwork header is incomplete.' : error instanceof Error ? error.message : 'Invalid artwork.');
  }
}

export function validateArtworkValue(value: unknown, maxDecodedBytes = MAX_ARTWORK_FILE_BYTES): ArtworkValidationResult {
  if (typeof value !== 'string' || !value || value !== value.trim()) return invalid('Artwork must be a nonempty image URL.');
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1) return invalid('Invalid artwork size limit.');
  if (!/^data:/i.test(value)) {
    if (value.length > MAX_URL_LENGTH || /[\s\\]/.test(value)
      || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || /%(?![\da-f]{2})/i.test(value)) return invalid('The artwork URL is invalid or too long.');
    try {
      const url = new URL(value);
      if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return invalid('Artwork URLs must use HTTP or HTTPS without embedded credentials.');
      return { ok: true };
    } catch { return invalid('The artwork URL is invalid.'); }
  }
  const limit = Math.min(maxDecodedBytes, MAX_ARTWORK_FILE_BYTES);
  if (value.length > 64 + 4 * Math.ceil(limit / 3)) return invalid('Artwork data exceeds the size limit.');
  const match = /^data:(image\/(?:jpeg|png|webp|gif|bmp|avif));base64,/i.exec(value);
  if (!match) return invalid('Artwork must use a supported image MIME type and base64 encoding.');
  const encoded = value.slice(match[0].length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return invalid('Artwork data is not valid base64.');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  if (!size || size > limit || (padding && (alphabet.indexOf(encoded[encoded.length - padding - 1]) & (padding === 2 ? 15 : 3)))) return invalid('Artwork base64 data is invalid or exceeds the size limit.');
  const decoded = atob(encoded);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return validateArtworkBytes(bytes, match[1].toLowerCase() as SupportedArtworkMimeType);
}

export function prepareCustomArtworkImport(entries: unknown): Array<{ mediaId: string; target: ArtworkStorageTarget; dataUrl: string }> {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Artwork import data must be an object.');
  const records: Array<{ mediaId: string; target: ArtworkStorageTarget; dataUrl: string }> = [];
  let bytes = 0, rows = 0;
  for (const [mediaId, targets] of Object.entries(entries)) {
    if (!mediaId.trim() || mediaId.length > 1024 || !targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('Artwork import has an invalid media id or targets.');
    for (const [target, dataUrl] of Object.entries(targets)) {
      if (++rows > MAX_ARTWORK_IMPORT_COUNT) throw new Error('Artwork import is limited to 512 rows.');
      assertArtworkStorageTarget(target);
      if (dataUrl === '') continue;
      if (typeof dataUrl !== 'string') throw new Error('Artwork import values must be strings.');
      if (dataUrl.length > MAX_ARTWORK_IMPORT_BYTES - bytes) throw new Error('Artwork import exceeds 64 MB.');
      bytes += new TextEncoder().encode(dataUrl).byteLength;
      if (bytes > MAX_ARTWORK_IMPORT_BYTES) throw new Error('Artwork import exceeds 64 MB.');
      const result = validateArtworkValue(dataUrl);
      if (!result.ok) throw new Error(result.message);
      records.push({ mediaId, target, dataUrl });
    }
  }
  return records;
}
