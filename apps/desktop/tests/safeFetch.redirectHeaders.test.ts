import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFetch } from '../src/main/safeFetch.ts';
import { sensitiveRedirectHeaders } from './fixtures/stremioSecurityFixtures.ts';

test('safeFetch strips credentials and configuration headers on cross-origin redirects', async () => {
  const seen: Headers[] = [];
  let requestCount = 0;
  const response = await safeFetch('https://provider.example/manifest.json', {
    headers: sensitiveRedirectHeaders,
  }, {
    maxRedirects: 1,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (_url, init) => {
      seen.push(new Headers(init.headers));
      requestCount += 1;
      return requestCount === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/manifest.json' } })
        : new Response('{"ok":true}', { status: 200 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].get('authorization'), sensitiveRedirectHeaders.authorization);
  assert.equal(seen[1].get('authorization'), null);
  assert.equal(seen[1].get('cookie'), null);
  assert.equal(seen[1].get('x-api-key'), null);
  assert.equal(seen[1].get('x-config-secret'), null);
  assert.equal(seen[1].get('x-request-id'), sensitiveRedirectHeaders['x-request-id']);
});
