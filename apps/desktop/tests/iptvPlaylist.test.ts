import assert from 'node:assert/strict';
import test from 'node:test';

import { parseM3uPlaylist, splitExtInfLine, parseExtInfAttributes } from '../src/main/iptv/m3uPlaylist.ts';

test('m3u parser reads tvg attributes, groups, and stream URLs', () => {
  const playlist = [
    '#EXTM3U x-tvg-url="https://guide.example/epg.xml"',
    '#EXTINF:-1 tvg-id="hbo.us" tvg-name="HBO" tvg-logo="https://cdn.example/hbo.png" group-title="Movies",HBO HD',
    '#EXTVLCOPT:http-user-agent=LoomTV',
    'https://stream.example/hbo/index.m3u8',
    '#EXTINF:-1 tvg-id="cnn.us" group-title="News",CNN',
    'https://stream.example/cnn/index.m3u8',
  ].join('\n');

  const result = parseM3uPlaylist(playlist);

  assert.equal(result.epgUrl, 'https://guide.example/epg.xml');
  assert.equal(result.channels.length, 2);
  assert.deepEqual(
    {
      channelId: result.channels[0].channelId,
      name: result.channels[0].name,
      tvgId: result.channels[0].tvgId,
      logoUrl: result.channels[0].logoUrl,
      groupTitle: result.channels[0].groupTitle,
      streamUrl: result.channels[0].streamUrl,
    },
    {
      channelId: 'hbo.us',
      name: 'HBO HD',
      tvgId: 'hbo.us',
      logoUrl: 'https://cdn.example/hbo.png',
      groupTitle: 'Movies',
      streamUrl: 'https://stream.example/hbo/index.m3u8',
    },
  );
  // The stored search column is what channel search matches against.
  assert.equal(result.channels[0].searchText, 'hbo hd movies hbo hbo us');
});

test('m3u parser splits the title on the comma outside quoted attributes', () => {
  const line = '#EXTINF:-1 tvg-id="x" group-title="Sports, Live",ESPN 2';
  const { header, title } = splitExtInfLine(line);

  assert.equal(title, 'ESPN 2');
  assert.equal(parseExtInfAttributes(header)['group-title'], 'Sports, Live');
});

test('m3u parser skips plain-HTTP channels and counts them', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1,Insecure Channel',
    'http://stream.example/insecure.ts',
    '#EXTINF:-1,Secure Channel',
    'https://stream.example/secure/index.m3u8',
  ].join('\n');

  const result = parseM3uPlaylist(playlist);

  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].name, 'Secure Channel');
  assert.equal(result.skippedInsecure, 1);
});

test('m3u parser drops duplicate stream URLs and headers with no URL', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1,First',
    'https://stream.example/one',
    '#EXTINF:-1,Duplicate',
    'https://stream.example/one',
    '#EXTINF:-1,Dangling header with no URL',
  ].join('\n');

  const result = parseM3uPlaylist(playlist);

  assert.equal(result.channels.length, 1);
  assert.equal(result.skippedDuplicate, 1);
  assert.equal(result.skippedMalformed, 1);
});

test('m3u parser keeps quality variants that share one tvg-id distinct', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="hbo.us",HBO HD',
    'https://stream.example/hbo-hd',
    '#EXTINF:-1 tvg-id="hbo.us",HBO SD',
    'https://stream.example/hbo-sd',
  ].join('\n');

  const result = parseM3uPlaylist(playlist);

  assert.equal(result.channels.length, 2);
  assert.notEqual(result.channels[0].channelId, result.channels[1].channelId);
  // Both still join to the same guide channel.
  assert.equal(result.channels[0].tvgId, 'hbo.us');
  assert.equal(result.channels[1].tvgId, 'hbo.us');
});

test('m3u parser applies #EXTGRP to the entries that follow it', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTGRP:Kids',
    '#EXTINF:-1,Cartoon One',
    'https://stream.example/one',
    '#EXTINF:-1 group-title="Docs",Nature',
    'https://stream.example/two',
  ].join('\n');

  const result = parseM3uPlaylist(playlist);

  assert.equal(result.channels[0].groupTitle, 'Kids');
  // An explicit group-title on the entry wins over the ambient #EXTGRP.
  assert.equal(result.channels[1].groupTitle, 'Docs');
});

test('m3u parser rejects a non-HTTPS channel logo rather than storing it', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="http://cdn.example/logo.png",Channel',
    'https://stream.example/one',
  ].join('\n');

  assert.equal(parseM3uPlaylist(playlist).channels[0].logoUrl, '');
});
