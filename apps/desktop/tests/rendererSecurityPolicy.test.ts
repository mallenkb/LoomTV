import assert from 'node:assert/strict';
import test from 'node:test';

import { rendererConnectSources } from '../src/main/rendererSecurityPolicy.ts';

test('allows the LoomTV media protocol for media requests', () => {
  assert.equal(rendererConnectSources(false).includes('loomtv:'), true);
});

test('keeps the legacy media protocol available for cached URLs', () => {
  assert.equal(rendererConnectSources(false).includes('plexserver:'), true);
});

test('only allows dev websocket sources when the dev server is active', () => {
  assert.equal(rendererConnectSources(false).some((source) => source.startsWith('ws:')), false);
  assert.equal(rendererConnectSources(true).some((source) => source.startsWith('ws:')), true);
});
