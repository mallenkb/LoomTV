import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import sharp from 'sharp';
import {
  inspectArtworkBytes,
  artworkNegativeCacheAllows,
  rememberArtworkFailure,
  sanitizeArtworkBytes,
  sanitizeArtworkBytesWithDecoder,
  type ArtworkDecoder,
  type ArtworkSanitizerOptions,
} from '../src/main/artworkSecurity.ts';

async function pngFixture(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 48, channels: 4, background: '#80503080' } }).png().toBuffer();
}

function fallbackDecoder(bytes: Buffer, onDecode: () => void): ArtworkDecoder {
  const { width, height } = inspectArtworkBytes(bytes);
  return {
    createFromBuffer: () => {
      onDecode();
      return { isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => bytes, toJPEG: () => bytes };
    },
  };
}

function workerFactory(source: string): ArtworkSanitizerOptions['workerFactory'] {
  return (_source, options) => new Worker(source, options);
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write('IEND', 37);
  return bytes;
}

test('artwork security rejects SVG, unknown signatures, and animated image containers', () => {
  assert.throws(() => inspectArtworkBytes(Buffer.from('<svg/>'), 'image/svg+xml'), /SVG/);
  assert.throws(() => inspectArtworkBytes(Buffer.from('not-an-image'), 'image/png'), /signature/);
  assert.throws(() => inspectArtworkBytes(Buffer.from('GIF89a'), 'image/gif'), /signature|incomplete|frame/);
});

test('artwork failures are negatively cached for the bounded retry window', () => {
  const source = 'https://images.example/bad.webp';
  assert.equal(artworkNegativeCacheAllows(source, 100), true);
  rememberArtworkFailure(source, 100);
  assert.equal(artworkNegativeCacheAllows(source, 101), false);
  assert.equal(artworkNegativeCacheAllows(source, 100 + 5 * 60 * 1000 + 1), true);
});

test('artwork is decoded in a real worker without calling the main-thread fallback', async () => {
  const bytes = await pngFixture();
  let fallbackCalls = 0;
  let workers = 0;
  const output = await sanitizeArtworkBytes(bytes, 'image/png', {
    fallbackDecoder: fallbackDecoder(bytes, () => { fallbackCalls += 1; }),
    workerFactory: (source, options) => {
      workers += 1;
      assert.equal(options.resourceLimits?.maxOldGenerationSizeMb, 64);
      assert.equal(options.resourceLimits?.maxYoungGenerationSizeMb, 16);
      const worker = new Worker(source, options);
      assert.ok(worker.threadId > 0);
      return worker;
    },
  });
  assert.equal(workers, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(output.mimeType, 'image/png');
  assert.deepEqual([output.width, output.height], [32, 48]);
  assert.equal(output.byteLength, output.bytes.byteLength);
  assert.equal(output.contentHash, createHash('sha256').update(output.bytes).digest('hex'));
});

test('unavailable worker construction and decoder loading use the fallback and log only once', async () => {
  const bytes = await pngFixture();
  let fallbackCalls = 0;
  const warnings: string[] = [];
  const options: ArtworkSanitizerOptions = {
    fallbackDecoder: fallbackDecoder(bytes, () => { fallbackCalls += 1; }),
    warn: (message) => warnings.push(message),
    workerFactory: () => { throw new Error('worker cannot start'); },
  };
  assert.equal((await sanitizeArtworkBytes(bytes, 'image/png', options)).mimeType, 'image/png');
  options.workerFactory = (source, settings) => new Worker(source, {
    ...settings,
    workerData: { ...settings.workerData, decoderModulePath: '/missing-artwork-decoder.cjs' },
  });
  assert.equal((await sanitizeArtworkBytes(bytes, 'image/png', options)).mimeType, 'image/png');
  assert.equal(fallbackCalls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /main-thread nativeImage fallback.*worker cannot start/);
});

test('invalid signatures and oversized dimensions are rejected before a worker or fallback starts', async () => {
  let starts = 0;
  const options: ArtworkSanitizerOptions = {
    workerFactory: () => { starts += 1; throw new Error('unexpected worker'); },
  };
  for (const bytes of [Buffer.from('<svg/>'), Buffer.alloc(5 * 1024 * 1024 + 1), pngHeader(8193, 1), pngHeader(8000, 8000)]) {
    await assert.rejects(sanitizeArtworkBytes(bytes, '', options), /Artwork rejected/);
  }
  assert.equal(starts, 0);
});

test('corrupt pixel data is rejected without falling back after the decoder starts', async () => {
  const bytes = pngHeader(32, 48);
  let fallbackCalls = 0;
  await assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', {
    fallbackDecoder: fallbackDecoder(bytes, () => { fallbackCalls += 1; }),
  }), /Artwork rejected/);
  assert.equal(fallbackCalls, 0);
});

test('decoder crashes and timeouts after initialization never call the fallback', async () => {
  const bytes = await pngFixture();
  let fallbackCalls = 0;
  const options = { fallbackDecoder: fallbackDecoder(bytes, () => { fallbackCalls += 1; }) };
  const ready = "const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ ready: true });";
  await assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', {
    ...options, workerFactory: workerFactory(`${ready} parentPort.once('message', () => { throw new Error('decode crashed'); });`),
  }), /decode crashed/);
  await assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', {
    ...options, workerFactory: workerFactory(`${ready} setInterval(() => {}, 1000);`),
  }), /time limit/);
  assert.equal(fallbackCalls, 0);
});

test('worker results must fit the output limit and agree with the inspected dimensions and mime type', async () => {
  const bytes = await pngFixture();
  for (const result of [
    "{ ok: true, bytes: new Uint8Array(2 * 1024 * 1024 + 1), mimeType: 'image/png', width: 32, height: 48 }",
    "{ ok: true, bytes: workerData.bytes, mimeType: 'image/png', width: 33, height: 48 }",
    "{ ok: true, bytes: workerData.bytes, mimeType: 'image/jpeg', width: 32, height: 48 }",
  ]) {
    await assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', {
      workerFactory: workerFactory(`const { parentPort, workerData } = require('node:worker_threads');
        parentPort.postMessage({ ready: true }); parentPort.postMessage(${result});`),
    }), /size is invalid|dimensions differ|content type does not match/);
  }
});

test('the pixel budget waits for worker exit before starting another large decode', async () => {
  const bytes = pngHeader(6000, 4000);
  let active = 0;
  let maximum = 0;
  let started = 0;
  const options: ArtworkSanitizerOptions = {
    workerFactory: (_source, settings) => {
      active += 1;
      started += 1;
      maximum = Math.max(maximum, active);
      const worker = new Worker(`const { parentPort } = require('node:worker_threads');
        parentPort.postMessage({ ready: true });
        setTimeout(() => parentPort.postMessage({ ok: false, error: 'fixture rejection' }), 20);
        setInterval(() => {}, 1000);`, settings);
      worker.once('exit', () => { active -= 1; });
      return worker;
    },
  };
  await Promise.all([1, 2, 3].map(() => assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', options), /fixture rejection/)));
  assert.equal(started, 3);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

test('the fallback keeps decoded dimensions and normalized output bounded', async () => {
  const bytes = await pngFixture();
  const decoder = fallbackDecoder(bytes, () => undefined);
  const decoded = decoder.createFromBuffer(bytes);
  assert.throws(() => sanitizeArtworkBytesWithDecoder(bytes, 'image/png', {
    createFromBuffer: () => ({ ...decoded, getSize: () => ({ width: 33, height: 48 }) }),
  }), /dimensions differ/);
  assert.throws(() => sanitizeArtworkBytesWithDecoder(bytes, 'image/png', {
    createFromBuffer: () => ({ ...decoded, toPNG: () => Buffer.alloc(2 * 1024 * 1024 + 1) }),
  }), /normalized image size/);
});

test('JPEG posters stay JPEG, strip metadata, and are smaller than the previous PNG encoding', async (t) => {
  const width = 500;
  const height = 750;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 17;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[(y * width + x) * 3 + channel] = Math.round(100 + 60 * Math.sin(x / 40 + y / 80 + channel) + (seed % 31));
      }
    }
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .withMetadata({ exif: { IFD0: { ImageDescription: 'Untrusted poster metadata' } } })
    .jpeg({ quality: 92 }).toBuffer();
  const previousPng = await sharp(input).png().toBuffer();
  let fallbackCalls = 0;
  const output = await sanitizeArtworkBytes(input, 'image/jpeg', {
    fallbackDecoder: fallbackDecoder(input, () => { fallbackCalls += 1; }),
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(output.mimeType, 'image/jpeg');
  assert.equal(inspectArtworkBytes(output.bytes, output.mimeType).format, 'jpeg');
  assert.deepEqual([output.width, output.height], [width, height]);
  assert.ok(output.byteLength < previousPng.byteLength / 3);
  t.diagnostic(`500x750 poster fixture: JPEG input ${input.length} bytes, sanitized JPEG ${output.byteLength} bytes, reference PNG ${previousPng.length} bytes`);
  assert.equal(output.contentHash, createHash('sha256').update(output.bytes).digest('hex'));
  const metadata = await sharp(output.bytes).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test('WebP and single-frame GIF are re-encoded as PNG', async () => {
  const png = await pngFixture();
  for (const [input, mime] of [
    [await sharp(png).webp().toBuffer(), 'image/webp'],
    [await sharp(png).gif().toBuffer(), 'image/gif'],
  ] as const) {
    const output = await sanitizeArtworkBytes(input, mime);
    assert.equal(output.mimeType, 'image/png');
    assert.equal(inspectArtworkBytes(output.bytes, output.mimeType).format, 'png');
    assert.deepEqual([output.width, output.height], [32, 48]);
  }
});

test('JPEG fallback never encodes PNG and lowers quality only to meet the output limit', async () => {
  const input = await sharp(await pngFixture()).jpeg().toBuffer();
  const qualities: number[] = [];
  const decoder = fallbackDecoder(input, () => undefined);
  const decoded = decoder.createFromBuffer(input);
  const output = sanitizeArtworkBytesWithDecoder(input, 'image/jpeg', {
    createFromBuffer: () => ({
      ...decoded,
      toPNG: () => { throw new Error('JPEG must not encode PNG'); },
      toJPEG: (quality) => {
        qualities.push(quality);
        return quality === 72 ? input : Buffer.alloc(2 * 1024 * 1024 + 1);
      },
    }),
  });
  assert.equal(output.mimeType, 'image/jpeg');
  assert.deepEqual(qualities, [88, 82, 72]);
});

test('the real worker rejects a decoder dimension mismatch without fallback', async () => {
  const bytes = await pngFixture();
  let fallbackCalls = 0;
  await assert.rejects(sanitizeArtworkBytes(bytes, 'image/png', {
    fallbackDecoder: fallbackDecoder(bytes, () => { fallbackCalls += 1; }),
    workerFactory: (source, options) => new Worker(source, {
      ...options, workerData: { ...options.workerData, expectedWidth: 31 },
    }),
  }), /encoded and decoded dimensions differ/);
  assert.equal(fallbackCalls, 0);
});
