import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/setup.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `section not found: ${start}`);
  return html.slice(from, to);
}

function setupContext({ protocol = 'http:', returnTo = 'app', cookie = '', fetch, sessionStorage } = {}) {
  const fields = {};
  const context = vm.createContext({
    API: '/api/v1', returnTo, fetch, sessionStorage,
    document: { cookie },
    $: (id) => fields[id] ||= { value: '', dataset: {}, focus() {} },
    window: { location: { protocol, replace: (target) => { context.navigated = target; } }, setTimeout() {} },
    setBusy() {}, fieldError() {}, renderRoots() {}, renderMetadataProviders() {}, renderReady() {},
    showStep: (step) => { context.shownStep = step; },
    showError: (message) => assert.fail(message),
  });
  vm.runInContext(section('const state =', 'const setBusy ='), context);
  for (const [start, end] of [
    ['async function api(', 'function renderSteps('],
    ['async function loadRoots(', 'function renderMetadataProviders('],
    ['function adoptSession(', 'async function persistStep('],
    ['async function createOwner(', 'async function addRoot('],
    ['async function finish(', 'async function onContinue('],
    ['function readCsrfCookie(', "$('continueButton').addEventListener"],
  ]) vm.runInContext(section(start, end), context);
  return context;
}

test('setup bearer authentication works through completion without web storage', async () => {
  assert.ok(!/sessionStorage\.(?:getItem|setItem)/.test(html));
  assert.ok(!html.includes('localStorage'));
  const requests = [];
  const context = setupContext({ fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/setup/state')) return Response.json({ data: { required: true, ownerConfigured: false } });
    if (url.endsWith('/setup/owner')) {
      assert.equal(JSON.parse(options.body).sessionMode, 'bearer');
      return Response.json({ data: { adminToken: 'fixture-token' } });
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return Response.json({ data: url.endsWith('/setup/complete') ? { redirect: '/app/' } : { roots: [] } });
  } });
  await context.boot();
  assert.equal(context.shownStep, 'account');
  context.$('ownerName').value = 'Owner';
  context.$('ownerPassword').value = 'fixture-password';
  context.$('ownerPasswordConfirm').value = 'fixture-password';
  await context.createOwner();
  assert.equal(context.shownStep, 'libraries');
  await context.finish();
  assert.equal(context.navigated, '/app/');
  assert.deepEqual(requests.map(({ url }) => url), [
    '/api/v1/setup/state', '/api/v1/setup/owner', '/api/v1/setup/libraries', '/api/v1/setup/complete',
  ]);
});

test('boot removes legacy tokens without reading them and tolerates blocked storage', async () => {
  for (const protocol of ['http:', 'https:']) {
    for (const blocked of [false, true]) {
      const removed = [];
      const context = setupContext({ protocol, sessionStorage: {
        getItem: () => assert.fail('Legacy tokens must not be read'),
        setItem: () => assert.fail('Tokens must not be persisted'),
        removeItem(key) {
          removed.push(key);
          if (blocked) throw new Error('Storage is blocked');
        },
      }, fetch: async (url, options) => {
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ data: { required: true, ownerConfigured: false } });
      } });
      await context.boot();
      assert.deepEqual(removed, ['loomtv.adminToken']);
      assert.equal(context.shownStep, 'account');
    }
  }
});

test('reloading setup in bearer mode asks for sign-in and resumes with a memory-only token', async () => {
  const context = setupContext({ fetch: async (url, options) => {
    if (url.endsWith('/setup/state')) return Response.json({ data: { required: true, ownerConfigured: true, step: 'libraries' } });
    if (url.endsWith('/auth/session')) return Response.json({ data: { adminToken: 'renewed-token' } });
    if (!options.headers.Authorization) return Response.json({ error: { code: 'auth_required' } }, { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer renewed-token');
    return Response.json({ data: { roots: [] } });
  } });
  await context.boot();
  assert.equal(vm.runInContext('state.resuming', context), true);
  context.$('resumePassword').value = 'fixture-password';
  await context.signInToResume();
  assert.equal(vm.runInContext('state.resuming', context), false);
  assert.equal(context.shownStep, 'libraries');
  context.requireSignIn('metadata');
  assert.equal(vm.runInContext('state.bearer', context), '');
  assert.equal(vm.runInContext('state.pendingStep', context), 'metadata');
});

test('an expired bearer during completion clears the token and asks for sign-in', async () => {
  const context = setupContext({ fetch: async (url, options) => {
    assert.equal(url, '/api/v1/setup/complete');
    assert.equal(options.headers.Authorization, 'Bearer expired-token');
    return Response.json({ error: { code: 'session_expired' } }, { status: 401 });
  } });
  vm.runInContext("state.sessionMode = 'bearer'", context);
  context.adoptSession({ adminToken: 'expired-token' });
  await context.finish();
  assert.equal(vm.runInContext('state.bearer', context), '');
  assert.equal(vm.runInContext('state.resuming', context), true);
  assert.equal(vm.runInContext('state.finishing', context), false);
  assert.equal(vm.runInContext('state.pendingStep', context), 'ready');
  assert.equal(context.navigated, undefined);
});

test('finish follows only same-origin paths and otherwise uses the requested default', async () => {
  const accepted = ['/', '/app/', '/admin/?unlocked=1', '/%2fother.example', '/%2F%2Fother.example', '/%5cother.example', '/%252fother.example'];
  const rejected = [undefined, null, 1, {}, '', 'app/', '//other.example', '/\\other.example',
    'https://other.example/x', 'javascript:alert(1)', '/\n/other.example', '/\t/other.example'];
  for (const returnTo of ['app', 'admin']) {
    for (const redirect of [...accepted, ...rejected]) {
      const context = setupContext({ returnTo, fetch: async () => Response.json({ data: { redirect } }) });
      await context.finish();
      assert.equal(context.navigated, accepted.includes(redirect) ? redirect : `/${returnTo}/`);
      assert.equal(new URL(context.navigated, 'https://loomtv.example').origin, 'https://loomtv.example');
    }
  }
});

test('CSRF cookies decode safely and malformed values do not interrupt HTTPS boot', async () => {
  for (const [cookie, expected] of [
    ['__Host-loomtv_csrf=bad%2Fsequence%', 'bad%2Fsequence%'],
    ['other=value; __Host-loomtv_csrf=valid%2Fvalue', 'valid/value'],
    ['other=value', ''],
  ]) {
    const context = setupContext({ protocol: 'https:', cookie, fetch: async (url, options) => {
      assert.equal(options.headers['X-Loom-CSRF'] || '', expected);
      return Response.json({ data: { required: true, ownerConfigured: false } });
    } });
    assert.equal(context.readCsrfCookie(), expected);
    await context.boot();
    assert.equal(context.shownStep, 'account');
  }
});
