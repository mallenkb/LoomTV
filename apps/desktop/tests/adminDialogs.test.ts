import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

test('admin dialogs trap focus, block the background, close on Escape, restore focus and reopen', {
  skip: process.env.LOOMTV_BROWSER_TESTS !== '1',
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'loomtv-admin-dialog-test-'));
  const script = path.join(directory, 'run.cjs');
  await writeFile(script, `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const http = require('node:http');
    app.setPath('userData', ${JSON.stringify(directory)});
    app.whenReady().then(async () => {
      const html = fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('../src/headless/admin.html', import.meta.url)))}, 'utf8');
      const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
        else if (request.url === '/api/admin/bootstrap') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ownerConfigured: true, user: { permissions: ['*'] }, library: { roots: [] } })); }
        else if (request.url.startsWith('/api/')) { response.setHeader('Content-Type', 'application/json'); response.end('{}'); }
        else { response.statusCode = 404; response.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
      const evaluate = script => window.webContents.executeJavaScript(script, true);
      const key = async (key, modifiers = 0) => {
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers });
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers });
      };
      try {
        await window.loadURL('http://127.0.0.1:' + server.address().port);
        window.webContents.debugger.attach('1.3');
        await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
        for (const [trigger, modal] of [['authButton', 'authModal'], ['changePasswordButton', 'passwordModal'], ['addUserButton', 'userModal'], ['testRootTrigger', 'rootModal']]) {
          if (trigger === 'testRootTrigger') {
            await evaluate(${JSON.stringify('document.querySelector(\'[data-page="library"]\').click()')});
            await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
            await evaluate(${JSON.stringify('document.querySelector("[data-add-root-kind]").id = "testRootTrigger"')});
          }
          await evaluate('document.getElementById(' + JSON.stringify(trigger) + ').hidden = false; document.getElementById(' + JSON.stringify(trigger) + ').style.display = "block"');
          if (trigger === 'addUserButton') await evaluate(${JSON.stringify('document.querySelector(\'[data-page="users"]\').click()')});
          for (let round = 0; round < 2; round++) {
            await evaluate('document.getElementById(' + JSON.stringify(trigger) + ').focus(); document.getElementById(' + JSON.stringify(trigger) + ').click()');
            assert.equal(await evaluate('document.getElementById(' + JSON.stringify(modal) + ').matches(":modal")'), true);
            assert.equal(await evaluate('document.getElementById(' + JSON.stringify(modal) + ').contains(document.activeElement)'), true);
            await evaluate('document.getElementById("refreshButton").focus()');
            assert.notEqual(await evaluate('document.activeElement.id'), 'refreshButton');
            for (let press = 0; press < 12; press++) {
              await key('Tab', press % 2 ? 8 : 0);
              assert.equal(await evaluate('document.activeElement === document.body || document.getElementById(' + JSON.stringify(modal) + ').contains(document.activeElement)'), true);
            }
            await key('Escape');
            await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
            assert.equal(await evaluate('document.getElementById(' + JSON.stringify(modal) + ').open'), false);
            assert.equal(await evaluate('document.activeElement.id'), trigger);
          }
        }
        process.stdout.write('admin-dialogs-passed\\n');
      } finally { window.destroy(); server.close(); }
    }).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
  `);
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(require('electron') as string, [script], { env, timeout: 25_000 });
    assert.match(result.stdout, /admin-dialogs-passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
