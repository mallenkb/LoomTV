import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_ACCESS_HEADER,
  LOCAL_ACCESS_QUERY_PARAM,
  addLocalAccessToken,
  allowedCorsOrigin,
  hasValidLocalAccessToken,
  isLoopbackAddress,
  localAccessQuery,
  requestLanToken,
  timingSafeStringEqual,
} from '../src/main/serverSecurity.ts';
import { appendQueryToHlsPlaylist } from '../src/main/hlsPlaylist.ts';

test('loopback address detection handles IPv4, IPv6, and mapped IPv4', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.23'), false);
});

test('local access token accepts query, header, and bearer forms only when exact', () => {
  const expected = 'abc123abc123abc123abc123abc123';
  const queryUrl = new URL(`http://127.0.0.1:3847/stream?${LOCAL_ACCESS_QUERY_PARAM}=${expected}`);
  const headerUrl = new URL('http://127.0.0.1:3847/api/library');

  assert.equal(hasValidLocalAccessToken(queryUrl, {}, expected), true);
  assert.equal(hasValidLocalAccessToken(headerUrl, { [LOCAL_ACCESS_HEADER]: expected }, expected), true);
  assert.equal(hasValidLocalAccessToken(headerUrl, { authorization: `Bearer ${expected}` }, expected), true);
  assert.equal(hasValidLocalAccessToken(headerUrl, { [LOCAL_ACCESS_HEADER]: 'wrong' }, expected), false);
  assert.equal(hasValidLocalAccessToken(headerUrl, {}, expected), false);
});

test('LAN token remains separate from the local access token query parameter', () => {
  const url = new URL(`http://192.168.1.5:3847/api/lan/library?token=lan-token&${LOCAL_ACCESS_QUERY_PARAM}=local-token`);
  assert.equal(requestLanToken(url, {}), 'lan-token');
  assert.equal(requestLanToken(new URL('http://192.168.1.5:3847/api/lan/library'), { authorization: 'Bearer device-token' }), 'device-token');
});

test('CORS is restricted to the renderer origins that LoomTV expects', () => {
  const allowed = new Set(['http://localhost:5173']);

  assert.equal(allowedCorsOrigin('http://localhost:5173', allowed), 'http://localhost:5173');
  assert.equal(allowedCorsOrigin('null', allowed), 'null');
  assert.equal(allowedCorsOrigin('https://example.com', allowed), null);
});

test('local access helpers append stable token query parameters', () => {
  const params = addLocalAccessToken(new URLSearchParams({ path: '/tmp/movie.mkv' }), 'token-value');
  assert.equal(params.get('path'), '/tmp/movie.mkv');
  assert.equal(params.get(LOCAL_ACCESS_QUERY_PARAM), 'token-value');
  assert.equal(localAccessQuery('token-value'), `${LOCAL_ACCESS_QUERY_PARAM}=token-value`);
});

test('timing safe comparison rejects mismatched values and lengths without throwing', () => {
  assert.equal(timingSafeStringEqual('same', 'same'), true);
  assert.equal(timingSafeStringEqual('same', 'nope'), false);
  assert.equal(timingSafeStringEqual('short', 'much-longer'), false);
});

test('HLS playlists receive tokenized segment URLs without altering comments or absolute URLs', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:1.0,',
    'segment-00001.ts',
    '#EXTINF:1.0,',
    'segment-00002.ts?existing=1',
    'https://cdn.example.com/external.ts',
    '',
  ].join('\n');

  assert.equal(
    appendQueryToHlsPlaylist(playlist, `${LOCAL_ACCESS_QUERY_PARAM}=token-value`),
    [
      '#EXTM3U',
      '#EXTINF:1.0,',
      'segment-00001.ts?loomtvToken=token-value',
      '#EXTINF:1.0,',
      'segment-00002.ts?existing=1&loomtvToken=token-value',
      'https://cdn.example.com/external.ts',
      '',
    ].join('\n'),
  );
});
