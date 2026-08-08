import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFetch } from '../src/main/safeFetch.ts';

test('safeFetch pins the validated address and revalidates every redirect', async () => {
  const resolverResults = [
    [{ address: '93.184.216.34', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }],
  ];
  const requestedAddresses: string[] = [];

  await assert.rejects(
    () => safeFetch('https://provider.example/manifest.json', {}, {
      maxRedirects: 1,
      lookup: async () => resolverResults.shift() || [],
      requestImpl: async (_url, _init, address) => {
        requestedAddresses.push(address);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://provider.example/redirected.json' },
        });
      },
    }),
    /private or invalid address/,
  );

  assert.deepEqual(requestedAddresses, ['93.184.216.34']);
});

test('safeFetch returns a response through the pinned request boundary', async () => {
  let requestedAddress = '';
  const response = await safeFetch('https://provider.example/manifest.json', {}, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (_url, _init, address) => {
      requestedAddress = address;
      return new Response('{"ok":true}', { status: 200 });
    },
  });

  assert.equal(requestedAddress, '93.184.216.34');
  assert.equal(await response.text(), '{"ok":true}');
});

test('safeFetch propagates its bounded abort signal to the pinned request', async () => {
  await assert.rejects(
    () => safeFetch('https://provider.example/manifest.json', {}, {
      timeoutMs: 5,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    }),
    /aborted|signal/i,
  );
});

test('safeFetch rejects non-public DNS answers, including mapped and special ranges', async () => {
  for (const address of [
    '100.64.0.1',
    'ff02::1',
    '64:ff9b::192.0.2.1',
    '2002:c000:0201::1',
    '::ffff:7f00:1',
  ]) {
    await assert.rejects(
      () => safeFetch('https://provider.example/manifest.json', {}, {
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        requestImpl: async () => new Response('should not connect'),
      }),
      /private or invalid address/,
      address,
    );
  }
});
