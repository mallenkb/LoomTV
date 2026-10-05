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

test('a provider that stops answering is skipped after two failures, and recovers', async (t) => {
  const { resetProviderHealth, ProviderUnreachableError, UNREACHABLE_HOST_SKIP_MS } = await import('../src/main/safeFetch.ts');
  resetProviderHealth();
  t.after(resetProviderHealth);
  let requests = 0;
  let answering = false;
  const options = {
    timeoutMs: 20,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (_url: URL, init: RequestInit) => {
      requests += 1;
      if (answering) return new Response('ok');
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  };
  await assert.rejects(() => safeFetch('https://slow.example/a', {}, options), { name: 'AbortError' });
  await assert.rejects(() => safeFetch('https://slow.example/b', {}, options), { name: 'AbortError' });
  const started = Date.now();
  await assert.rejects(() => safeFetch('https://slow.example/c', {}, options), ProviderUnreachableError);
  assert.ok(Date.now() - started < 15, 'skipped without waiting for a timeout');
  assert.equal(requests, 2, 'no request is sent while the host is skipped');
  assert.equal((await safeFetch('https://other.example/x', {}, { ...options, timeoutMs: 1 }).catch((error) => error)).name, 'AbortError', 'other hosts are unaffected');

  answering = true;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + UNREACHABLE_HOST_SKIP_MS + 1);
  assert.equal(await (await safeFetch('https://slow.example/d', {}, options)).text(), 'ok', 'retried after the skip window');
  t.mock.restoreAll();
  assert.equal((await safeFetch('https://slow.example/e', {}, options)).status, 200, 'a response clears the failures');
});

test('a request the caller cancels does not count against the provider', async (t) => {
  const { resetProviderHealth } = await import('../src/main/safeFetch.ts');
  resetProviderHealth();
  t.after(resetProviderHealth);
  let requests = 0;
  let started: () => void = () => undefined;
  const options = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (_url: URL, init: RequestInit) => {
      requests += 1;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  };
  for (let index = 0; index < 3; index += 1) {
    const controller = new AbortController();
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const pending = safeFetch('https://cancelled.example/', { signal: controller.signal }, options);
    await inFlight;
    controller.abort();
    await assert.rejects(pending);
  }
  assert.equal(requests, 3, 'every cancelled request still reached the provider');
});

test('skip windows are saved, restored after a restart, and grow while a host stays down', async (t) => {
  const { resetProviderHealth, restoreProviderHealth, ProviderUnreachableError, UNREACHABLE_HOST_SKIP_MS } = await import('../src/main/safeFetch.ts');
  resetProviderHealth();
  t.after(resetProviderHealth);
  const saves: Array<Record<string, { skipUntil: number; strikes: number }>> = [];
  restoreProviderHealth(undefined, (state) => saves.push(state));
  let requests = 0;
  const options = {
    timeoutMs: 10,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (_url: URL, init: RequestInit) => {
      requests += 1;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  };
  await assert.rejects(() => safeFetch('https://down.example/a', {}, options));
  await assert.rejects(() => safeFetch('https://down.example/b', {}, options));
  assert.equal(saves.at(-1)?.['down.example'].strikes, 1);

  // A restart restores the window: no request is sent.
  const saved = saves.at(-1);
  resetProviderHealth();
  restoreProviderHealth(saved, (state) => saves.push(state));
  await assert.rejects(() => safeFetch('https://down.example/c', {}, options), ProviderUnreachableError);
  assert.equal(requests, 2);

  // After the window, one more failure skips it again for four times as long.
  const realNow = Date.now;
  const later = realNow() + UNREACHABLE_HOST_SKIP_MS + 1;
  t.mock.method(Date, 'now', () => later);
  await assert.rejects(() => safeFetch('https://down.example/d', {}, options), { name: 'AbortError' });
  const second = saves.at(-1)?.['down.example'];
  assert.equal(second?.strikes, 2);
  assert.equal(second?.skipUntil, later + UNREACHABLE_HOST_SKIP_MS * 4);
  t.mock.restoreAll();

  // Restored values are bounded and validated.
  resetProviderHealth();
  restoreProviderHealth({ 'bad host!': { skipUntil: 1, strikes: 1 }, 'far.example': { skipUntil: Number.MAX_SAFE_INTEGER, strikes: 1 } }, () => undefined);
  await assert.rejects(() => safeFetch('https://far.example/', {}, options), ProviderUnreachableError);
});
