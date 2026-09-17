import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lanMediaItemSchema,
  lanPlaybackCapabilitiesSchema,
  lanPlaybackPlanRequestSchema,
  lanProgressSavePayloadSchema,
  lanProgressSaveRequestSchema,
} from './src/schemas.ts';
import { parseProgressSavePayload } from '../video-contracts/src/index.mjs';
import { normalizeClientPlaybackCapabilities } from '../media-core/src/index.mjs';
import { playbackPlanResultSchema } from '../../apps/desktop/src/lib/desktopDecoders.ts';

test('detail metadata defaults missing cast without accepting malformed values', () => {
  const item = { id: 'movie-1', type: 'movie', title: 'Movie', year: 2024, poster: '', backdrop: '', summary: '', rating: 0, genres: [], filePath: 'movie-1' };
  assert.deepEqual(lanMediaItemSchema.parse(item), { ...item, cast: [] });
  const cast = [{ name: 'Actor', character: 'Role', image: '' }];
  assert.deepEqual(lanMediaItemSchema.parse({ ...item, year: 2024, cast }).cast, cast);
  for (const year of ['2024', null, Infinity, NaN]) assert.equal(lanMediaItemSchema.safeParse({ ...item, year }).success, false);
  assert.equal(lanMediaItemSchema.safeParse({ ...item, cast: 'Actor' }).success, false);
});

test('canonical progress validation and LAN mirror agree on payloads', () => {
  for (const input of [{ position: 0, duration: 0 }, { position: 61.5, duration: 120 },
    { position: 2, duration: 120, watched: true }, { position: 120, duration: 120, watched: false }]) {
    assert.deepEqual(parseProgressSavePayload(input), input);
    assert.deepEqual(lanProgressSavePayloadSchema.parse(input), input);
    assert.deepEqual(lanProgressSaveRequestSchema.parse({ ...input, mediaId: 'movie-1' }), { ...input, mediaId: 'movie-1' });
  }
  for (const input of [undefined, null, [], {}, { position: 10 }, { duration: 100 },
    { positionSeconds: 10, durationSeconds: 100 }, { position: '10', duration: 100 },
    { position: -1, duration: 100 }, { position: NaN, duration: 100 }, { position: Infinity, duration: 100 },
    { position: 10, duration: -1 }, { position: 10, duration: Infinity }, { position: 10, duration: null },
    { position: 10, duration: 100, watched: 'false' }]) {
    assert.throws(() => parseProgressSavePayload(input), { code: 'invalid_request', status: 400 });
    assert.equal(lanProgressSavePayloadSchema.safeParse(input).success, false);
  }
});

test('LAN requests and desktop responses preserve normalized playback capabilities', () => {
  for (const input of [
    { streamingProtocols: ['http'], subtitleModes: ['burn-in'], hdrFormats: [] },
    { streamingProtocols: ['http', 'hls'], subtitleModes: ['text', 'bitmap', 'external', 'burn-in'], hdrFormats: ['hdr10', 'hdr10-plus', 'hlg', 'dolby-vision'] },
  ]) {
    const capabilities = normalizeClientPlaybackCapabilities(input);
    assert.deepEqual(lanPlaybackCapabilitiesSchema.parse(capabilities), capabilities);
    const request = lanPlaybackPlanRequestSchema.parse({ mediaId: 'movie-1', capabilities });
    assert.deepEqual(normalizeClientPlaybackCapabilities(request.capabilities), capabilities);
    const response = playbackPlanResultSchema.parse({ ok: true, data: {
      mediaCoreContractVersion: 1, capabilities, plan: { mode: 'direct', reason: 'Compatible', sourceAction: 'direct' },
    } });
    assert.deepEqual(response.data.capabilities, capabilities);
  }
  assert.deepEqual(lanPlaybackCapabilitiesSchema.parse({ supportsHls: true }), { supportsHls: true });
});
