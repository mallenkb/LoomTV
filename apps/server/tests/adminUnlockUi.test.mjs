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
