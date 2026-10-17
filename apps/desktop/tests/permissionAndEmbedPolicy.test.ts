import assert from 'node:assert/strict';
import test from 'node:test';
import { installPermissionPolicy, isPermissionAllowed } from '../src/main/permissionPolicy.ts';
import { isTrustedVideoPageUrl, videoPageEmbedUrl, youtubeVideoId } from '../src/shared/externalPlayback.ts';

const policy = {
  isAppUrl: (url: string) => url.startsWith('loomtv://app'),
  isEmbeddedVideoUrl: (url: string) => url.startsWith('https://www.youtube-nocookie.com/') || url.startsWith('https://player.vimeo.com/'),
};

test('the app may go fullscreen and write the clipboard, and nothing else', () => {
  assert.equal(isPermissionAllowed('fullscreen', 'loomtv://app/index.html', policy), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'loomtv://app/index.html', policy), true);
  for (const permission of ['media', 'display-capture', 'geolocation', 'notifications', 'midiSysex', 'hid', 'usb', 'serial', 'clipboard-read', 'openExternal', 'pointerLock']) {
    assert.equal(isPermissionAllowed(permission, 'loomtv://app/index.html', policy), false, permission);
  }
});

test('framed video players may only go fullscreen, and other origins get nothing', () => {
  assert.equal(isPermissionAllowed('fullscreen', 'https://www.youtube-nocookie.com/embed/abcdefghijk', policy), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'https://player.vimeo.com/video/1', policy), false);
  assert.equal(isPermissionAllowed('media', 'https://player.vimeo.com/video/1', policy), false);
  assert.equal(isPermissionAllowed('fullscreen', 'https://example.com/', policy), false);
  assert.equal(isPermissionAllowed('fullscreen', undefined, policy), false);
});

test('installPermissionPolicy denies devices and screen capture in the session', () => {
  const handlers: Record<string, (...args: never[]) => unknown> = {};
  const session = {
    setPermissionRequestHandler: (handler: never) => { handlers.request = handler; },
    setPermissionCheckHandler: (handler: never) => { handlers.check = handler; },
    setDevicePermissionHandler: (handler: never) => { handlers.device = handler; },
    setDisplayMediaRequestHandler: (handler: never) => { handlers.display = handler; },
  };
  installPermissionPolicy(session as never, policy);
  const decisions: boolean[] = [];
  (handlers.request as (...args: unknown[]) => void)({}, 'media', (allowed: boolean) => decisions.push(allowed), { requestingUrl: 'loomtv://app/index.html' });
  (handlers.request as (...args: unknown[]) => void)({}, 'fullscreen', (allowed: boolean) => decisions.push(allowed), { requestingUrl: 'loomtv://app/index.html' });
  assert.deepEqual(decisions, [false, true]);
  assert.equal((handlers.check as (...args: unknown[]) => boolean)({}, 'geolocation', 'loomtv://app', {}), false);
  assert.equal((handlers.device as () => boolean)(), false);
  let streams: unknown;
  (handlers.display as (...args: unknown[]) => void)({}, (value: unknown) => { streams = value; });
  assert.deepEqual(streams, {});
});

test('every accepted YouTube page form becomes a nocookie embed URL', () => {
  const id = 'dQw4w9WgXcQ';
  for (const page of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL1`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    const embed = videoPageEmbedUrl(page);
    assert.ok(embed, page);
    const url = new URL(embed);
    assert.equal(url.origin, 'https://www.youtube-nocookie.com', page);
    assert.equal(url.pathname, `/embed/${id}`, page);
  }
  assert.equal(new URL(videoPageEmbedUrl(`https://youtu.be/${id}?t=1m30s`) || '').searchParams.get('start'), '90');
  assert.equal(new URL(videoPageEmbedUrl(`https://www.youtube.com/watch?v=${id}&t=42`) || '').searchParams.get('start'), '42');
});

test('Vimeo pages become player.vimeo.com embeds and keep an unlisted hash', () => {
  assert.equal(new URL(videoPageEmbedUrl('https://vimeo.com/76979871') || '').pathname, '/video/76979871');
  const unlisted = new URL(videoPageEmbedUrl('https://vimeo.com/76979871/abc123def') || '');
  assert.equal(unlisted.origin, 'https://player.vimeo.com');
  assert.equal(unlisted.searchParams.get('h'), 'abc123def');
  assert.equal(new URL(videoPageEmbedUrl('https://player.vimeo.com/video/76979871?h=ff00') || '').searchParams.get('h'), 'ff00');
});

test('accepted hosts without a single video have no embed, and other hosts are not video pages', () => {
  assert.equal(isTrustedVideoPageUrl('https://www.youtube.com/@channel'), true);
  assert.equal(videoPageEmbedUrl('https://www.youtube.com/@channel'), null);
  assert.equal(videoPageEmbedUrl('https://www.youtube.com/playlist?list=PL1'), null);
  assert.equal(videoPageEmbedUrl('https://vimeo.com/channels/staffpicks'), null);
  assert.equal(videoPageEmbedUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(videoPageEmbedUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});
