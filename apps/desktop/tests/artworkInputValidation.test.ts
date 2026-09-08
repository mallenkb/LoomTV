import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARTWORK_FILE_BYTES,
  MAX_ARTWORK_IMPORT_COUNT,
  prepareCustomArtworkImport,
  validateArtworkBytes,
  validateArtworkDimensions,
  validateArtworkFile,
  validateArtworkValue,
  type SupportedArtworkMimeType,
} from '../src/lib/artworkInputValidation.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/dsAAAAASUVORK5CYII=', 'base64');
const dataUrl = (bytes: Uint8Array, mime = 'image/png') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);
function webp(): Buffer {
  const bytes = Buffer.alloc(26);
  bytes.write('RIFF'); bytes.writeUInt32LE(18, 4); bytes.write('WEBPVP8L', 8);
  bytes.writeUInt32LE(5, 16); bytes[20] = 0x2f;
  return bytes;
}
function bmp(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  return bytes;
}

test('file metadata enforces the 16 MiB limit before reading', () => {
  for (const size of [undefined, NaN, Infinity, -1, 0, 1.5, MAX_ARTWORK_FILE_BYTES + 1]) {
    assert.equal(validateArtworkFile({ name: 'poster.png', size }).ok, false);
  }
  assert.equal(validateArtworkFile({ name: 'poster.png', size: MAX_ARTWORK_FILE_BYTES }).ok, true);
  assert.equal(validateArtworkFile({ name: 'poster.jpg', type: 'application/octet-stream', size: 1 }).ok, true);
  assert.equal(validateArtworkFile({ name: 'poster.svg', type: 'image/svg+xml', size: 1 }).ok, false);
});

test('only absolute HTTP and HTTPS URL workflows remain available', () => {
  for (const url of [
    'https://image.tmdb.org/t/p/w500/poster.jpg',
    'http://127.0.0.1:1234/api/thumbnail?resourceId=abc&access_token=abc',
    'https://example.com/a%20b.png?v=2#image',
  ]) assert.equal(validateArtworkValue(url).ok, true, url);
  for (const url of [
    '', ' ', 'poster.png', '/tmp/poster.png', '//example.com/poster.png',
    'javascript:alert(1)', 'file:///tmp/a.png', 'blob:https://example.com/id',
    'https://user:pass@example.com/a.png', 'https:example.com/a.png',
    'https://example.com/\na.png', 'https://example.com\\a.png', 'https://example.com/%zz',
    `https://example.com/${'x'.repeat(8192)}`, ' https://example.com/a.png',
  ]) assert.equal(validateArtworkValue(url).ok, false, url.slice(0, 100));
});

test('base64 data must have supported MIME, canonical encoding, and matching image bytes', () => {
  assert.equal(validateArtworkValue(dataUrl(png)).ok, true);
  for (const value of [
    dataUrl(png, 'image/svg+xml'), dataUrl(png, 'image/jpeg'),
    dataUrl(png).replace(';base64', ';charset=utf8;base64'),
    'data:image/png;base64,poster', 'data:image/png;base64,A===',
    'data:image/png;base64,AB==', 'data:image/png;base64,AAAA\n',
    'data:image/png;base64,', 'data:image/png,hello',
    dataUrl(Buffer.from('<svg/>')),
  ]) assert.equal(validateArtworkValue(value).ok, false);
  assert.equal(validateArtworkValue(dataUrl(png), png.length - 1).ok, false);
  assert.equal(validateArtworkValue(dataUrl(png), png.length).ok, true);
  assert.equal(validateArtworkValue(`data:image/png;base64,${'A'.repeat(4 * Math.ceil(MAX_ARTWORK_FILE_BYTES / 3) + 100)}`).ok, false);
});

test('dimension checks enforce positive integers, 8192 per side, and 25 million pixels', () => {
  assert.equal(validateArtworkDimensions(5000, 5000).ok, true);
  assert.equal(validateArtworkDimensions(8192, 1).ok, true);
  for (const [width, height] of [[0, 1], [1, -1], [NaN, 1], [Infinity, 1], [1.1, 2], [8193, 1], [1, 8193], [5001, 5000]]) {
    assert.equal(validateArtworkDimensions(width, height).ok, false);
  }
});

for (const [mime, bytes] of [
  ['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif], ['image/webp', webp()], ['image/bmp', bmp()],
] as const) {
  test(`${mime} accepts bounded headers and rejects truncation and MIME mismatch`, () => {
    assert.equal(validateArtworkBytes(bytes, mime).ok, true);
    assert.equal(validateArtworkBytes(bytes.subarray(0, 4), mime).ok, false);
    assert.equal(validateArtworkBytes(bytes, mime === 'image/png' ? 'image/jpeg' : 'image/png').ok, false);
  });
}

test('oversized PNG, GIF, JPEG, BMP, and WebP dimensions fail before decoding', () => {
  const p = Buffer.from(png); p.writeUInt32BE(8193, 16);
  const g = Buffer.from(gif); g.writeUInt16LE(8193, 6);
  const j = Buffer.from(jpeg); j.writeUInt16BE(8193, 9);
  const b = bmp(); b.writeInt32LE(8193, 18);
  const w = webp(); w.writeUInt32LE(8192, 21);
  for (const [mime, bytes] of [['image/png', p], ['image/gif', g], ['image/jpeg', j], ['image/bmp', b], ['image/webp', w]] as const) {
    assert.equal(validateArtworkBytes(bytes, mime).ok, false, mime);
  }
});

test('unsupported local AVIF, BMP compression, animation, and overflowing chunks are rejected', () => {
  assert.equal(validateArtworkBytes(Buffer.from('....ftypavif'), 'image/avif').ok, false);
  const b = bmp(); b.writeUInt32LE(1, 30);
  assert.equal(validateArtworkBytes(b, 'image/bmp').ok, false);
  const p = Buffer.from(png); p.write('acTL', 37);
  assert.equal(validateArtworkBytes(p, 'image/png').ok, false);
  const hugeChunk = Buffer.from(png); hugeChunk.writeUInt32BE(0xffffffff, 33);
  assert.equal(validateArtworkBytes(hugeChunk, 'image/png').ok, false);
  const w = webp(); w.write('ANMF', 12);
  assert.equal(validateArtworkBytes(w, 'image/webp').ok, false);
  const overflow = webp(); overflow.writeUInt32LE(0xffffffff, 16);
  assert.equal(validateArtworkBytes(overflow, 'image/webp').ok, false);
});

test('JPEG header scanning is capped at 64 KiB', () => {
  const bytes = Buffer.alloc(70 * 1024);
  jpeg.copy(bytes);
  bytes[3] = 0xe1;
  bytes.writeUInt16BE(65535, 4);
  assert.equal(validateArtworkBytes(bytes, 'image/jpeg').ok, false);
});

test('arbitrary short inputs fail without throwing outside the pure validator', () => {
  const formats: SupportedArtworkMimeType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'];
  for (const mime of formats) {
    for (let size = 0; size < 40; size++) assert.equal(validateArtworkBytes(new Uint8Array(size).fill(255), mime).ok, false);
  }
});

test('imports validate targets and runtime shapes before returning any records', () => {
  const url = 'https://example.com/artwork.png';
  assert.equal(prepareCustomArtworkImport({ movie: { thumbnail: url, poster: url, cover: url, logo: url } }).length, 4);
  assert.deepEqual(prepareCustomArtworkImport({ movie: { poster: '' } }), []);
  for (const entries of [null, [], { movie: [] }, { '': { poster: url } }, { movie: { evil: '' } }, { movie: { poster: false } }, { movie: { poster: 0 } }, { movie: { poster: null } }]) {
    assert.throws(() => prepareCustomArtworkImport(entries));
  }
});

test('imports enforce 512 rows, including empty supported targets', () => {
  const rows = Object.fromEntries(Array.from({ length: MAX_ARTWORK_IMPORT_COUNT }, (_, index) => [`movie-${index}`, { poster: 'https://example.com/art.png' }]));
  assert.equal(prepareCustomArtworkImport(rows).length, MAX_ARTWORK_IMPORT_COUNT);
  assert.throws(() => prepareCustomArtworkImport({ ...rows, extra: { poster: '' } }), /512/);
});

test('imports enforce the aggregate 64 MiB limit before writing', () => {
  // A large bounded PNG chunk tests serialized import size without decoding pixels.
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  png.copy(bytes, 0, 0, 33);
  bytes.writeUInt32BE(bytes.length - 57, 33);
  bytes.write('IDAT', 37);
  png.copy(bytes, bytes.length - 12, png.length - 12);
  const value = dataUrl(bytes);
  assert.throws(() => prepareCustomArtworkImport({ movie: { poster: value, cover: value, logo: value, thumbnail: value } }), /64 MB/);
});
