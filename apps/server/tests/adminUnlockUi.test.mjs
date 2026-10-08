import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../desktop/src/headless/admin.html', import.meta.url), 'utf8');
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}

test('admin unlock uses native validation so autofill does not disable sign-in', () => {
  const fields = {
    authForm: { dataset: { firstRun: 'false' } },
    ownerPassword: { value: '1234' },
    authSubmit: { disabled: true },
  };
  const context = vm.createContext({ $: (id) => fields[id] });
  vm.runInContext(section('function updateAuthSubmitState()', 'function setPasswordVisibility('), context);
  context.updateAuthSubmitState();
  assert.equal(fields.ownerPassword.minLength, 1);
  assert.equal(fields.authSubmit.disabled, false);
  fields.authForm.dataset.firstRun = 'true';
  context.updateAuthSubmitState();
  assert.equal(fields.ownerPassword.minLength, 8);
  fields.authForm.dataset.busy = 'true';
  context.updateAuthSubmitState();
  assert.equal(fields.authSubmit.disabled, true);
});

test('invalid login preserves the server error without reopening and clearing the form', async () => {
  let prompts = 0;
  const context = vm.createContext({
    API: '/api/admin', state: { token: '', deviceId: 'fixture' },
    pendingReads: new Map(), AbortController,
    window: { setTimeout, clearTimeout },
    fetch: async () => Response.json({ message: 'The account name or password is incorrect.' }, { status: 401 }),
    setToken: () => assert.fail('A rejected login must not reset authentication state'),
    openAuth: () => { prompts += 1; },
  });
  vm.runInContext(section('function request(path', 'async function signOutAdmin('), context);
  await assert.rejects(context.request('/session', { method: 'POST', body: { password: 'fixture-password' } }), /account name or password is incorrect/);
  assert.equal(prompts, 0);
});

async function userFormContext() {
  const { AUTH_PERMISSIONS } = await import('../src/auth-policy.js');
  const fields = {};
  let permissionInputs = [];
  let rootInputs = [];
  const requests = [];
  const state = { bootstrap: { user: { rootIds: null }, library: { roots: [{ id: 'root-1', path: '/fixture/one' }, { id: 'root-2', path: '/fixture/two' }] } } };
  function field(id) {
    if (!fields[id]) {
      const node = { value: '', checked: false, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; }, showModal() {}, close() {}, focus() {} };
      Object.defineProperty(node, 'innerHTML', { set(html) {
        const inputs = [...html.matchAll(/<input[^>]*value="([^"]+)"([^>]*)>/g)].map((match) => ({ value: match[1], checked: match[2].includes(' checked') }));
        if (id === 'userPermissions') permissionInputs = inputs;
        if (id === 'userRoots') rootInputs = inputs;
      } });
      fields[id] = node;
    }
    return fields[id];
  }
  const context = vm.createContext({ state, $: field, text() {}, escapeHtml: String,
    document: { querySelectorAll(selector) {
      const inputs = selector.includes('userPermission') ? permissionInputs : rootInputs;
      return selector.includes(':checked') ? inputs.filter((input) => input.checked) : inputs;
    } }, request: async (url, options) => requests.push({ url, body: JSON.parse(JSON.stringify(options.body)) }), toast() {}, loadBootstrap() {}, error: assert.fail,
  });
  vm.runInContext(section('const USER_PERMISSIONS =', 'const $ ='), context);
  vm.runInContext(section('function renderUserForm(', 'async function refreshScan('), context);
  vm.runInContext(section("$('addUserButton').addEventListener", "document.addEventListener('click', async (event) => {"), context);
  return { AUTH_PERMISSIONS, context, fields, requests, state, submit: () => field('userForm').listeners.submit({ preventDefault() {} }) };
}

test('editing an account name preserves every authoritative permission and creation uses server defaults', async () => {
  const { AUTH_PERMISSIONS, context, fields, requests, submit } = await userFormContext();
  context.renderUserForm({ id: 'admin-1', name: 'Administrator', role: 'admin', permissions: AUTH_PERMISSIONS, rootIds: null });
  fields.userName.value = 'Renamed';
  await submit();
  assert.deepEqual(requests[0].body.permissions.sort(), [...AUTH_PERMISSIONS].sort());
  assert.equal(requests[0].body.name, 'Renamed');
  context.renderUserForm(null);
  fields.userName.value = 'New admin';
  fields.userRole.value = 'admin';
  fields.userRole.listeners.change();
  await submit();
  assert.equal(Object.hasOwn(requests.at(-1).body, 'permissions'), false);
});

test('the account form distinguishes future roots, current roots, and no roots', async () => {
  const { context, fields, requests, state, submit } = await userFormContext();
  assert.ok(html.includes('id="userAllRoots"'));
  for (const [scope, expected] of [[null, null], [['root-1'], ['root-1']], [[], []], [['root-1', 'root-2'], ['root-1', 'root-2']]]) {
    context.renderUserForm({ id: 'user-1', name: 'User', role: 'user', permissions: [], rootIds: scope });
    await submit();
    assert.deepEqual(requests.at(-1).body.rootIds, expected);
  }
  state.bootstrap.library.roots.push({ id: 'future-root', path: '/fixture/future' });
  context.renderUserForm({ id: 'user-1', name: 'User', role: 'user', permissions: [], rootIds: null });
  await submit();
  assert.equal(requests.at(-1).body.rootIds, null);
  state.bootstrap.user.rootIds = ['root-1'];
  context.renderUserForm(null);
  assert.equal(fields.userAllRoots.disabled, true);
  fields.userAllRoots.checked = true;
  await submit();
  assert.ok(Array.isArray(requests.at(-1).body.rootIds));
});
