import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rendererUrl = process.env.LOOMTV_SETTINGS_MODAL_RENDERER_URL
  || 'http://127.0.0.1:5187/tests/fixtures/settingsModals.html';

test('settings dialogs preserve modal styling, form alignment, focus behavior, and safe install state', {
  skip: process.env.LOOMTV_BROWSER_TESTS !== '1',
  timeout: 90_000,
}, async () => {
  const response = await fetch(rendererUrl);
  assert.equal(response.ok, true, `Settings modal fixture is unavailable at ${rendererUrl}; start the renderer dev server or set LOOMTV_SETTINGS_MODAL_RENDERER_URL.`);
  await response.body?.cancel();

  const directory = await mkdtemp(path.join(tmpdir(), 'loomtv-settings-modal-test-'));
  const script = path.join(directory, 'run.cjs');
  await writeFile(script, `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    app.setPath('userData', ${JSON.stringify(directory)});
    app.whenReady().then(async () => {
      const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const evaluate = (source) => window.webContents.executeJavaScript(source, true);
      const key = async (keyName, modifiers = 0) => {
        const windowsVirtualKeyCode = keyName === 'Tab' ? 9 : keyName === 'Escape' ? 27 : 0;
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: keyName, code: keyName, windowsVirtualKeyCode, modifiers,
        });
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode, modifiers,
        });
      };
      const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      try {
        await window.loadURL(${JSON.stringify(rendererUrl)});
        window.webContents.debugger.attach('1.3');
        await evaluate('new Promise(resolve => setTimeout(resolve, 180))');
        assert.equal(await evaluate('Boolean(window.__setSettingsModalWidth && window.__setSettingsModalTheme)'), true);
        assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');

        const widths = [460, 480, 520, 560, 600, 620, 640, 680, 768];
        for (const theme of ['dark', 'light']) {
          for (const homeStyle of ['default', 'modern']) {
            await evaluate('window.__setSettingsModalTheme(' + JSON.stringify(theme) + ', ' + JSON.stringify(homeStyle) + ')');
            for (const viewportWidth of [360, 1280]) {
              window.setContentSize(viewportWidth, 900);
              await evaluate('new Promise(resolve => setTimeout(resolve, 50))');
              assert.equal(await evaluate('window.innerWidth'), viewportWidth);

              for (const family of ['native']) {
                const trigger = family === 'native' ? 'open-native-modal' : 'open-v2-modal';
                const marker = family === 'native' ? 'native' : 'v2';
                await evaluate('document.getElementById(' + JSON.stringify(trigger) + ').click()');
                await evaluate('new Promise(resolve => setTimeout(resolve, 100))');

                for (const width of widths) {
                  await evaluate('window.__setSettingsModalWidth(' + width + ')');
                  await settle();
                  const result = await evaluate('(() => {\\n' +
                    'const family = ' + JSON.stringify(family) + ';\\n' +
                    'const panel = document.querySelector(".fixture-native-dialog");\\n' +
                    'if (!panel) return { error: "modal panel missing" };\\n' +
                    'const rect = panel.getBoundingClientRect();\\n' +
                    'const style = getComputedStyle(panel);\\n' +
                    'const number = value => Number.parseFloat(value);\\n' +
                    'const controls = [...panel.querySelectorAll("button, input:not([type=radio]):not([type=checkbox]):not([type=range]), select, textarea, [role=combobox], [role=radio], [role=tab], label:has(input[type=radio]), [data-ui-chip]")];\\n' +
                    'const badRadii = controls.filter(element => getComputedStyle(element).borderTopLeftRadius !== "10px").map(element => ({ tag: element.tagName, id: element.id, radius: getComputedStyle(element).borderTopLeftRadius }));\\n' +
                    'const form = panel.querySelector("form");\\n' +
                    'const liveInput = panel.querySelector("#iptv-source-name");\\n' +
                    'const manifestInput = panel.querySelector("#stremio-manifest-url");\\n' +
                    'const alignInput = family === "native" ? liveInput : manifestInput;\\n' +
                    'const inputRect = alignInput?.getBoundingClientRect();\\n' +
                    'const expectedInset = number(style.paddingLeft) + number(style.borderLeftWidth);\\n' +
                    'const livePlaylist = panel.querySelector("#iptv-playlist-url");\\n' +
                    'const iconGroup = panel.querySelector("[role=radiogroup]");\\n' +
                    'const firstIcon = iconGroup?.querySelector("label");\\n' +
                    'const firstIconSvg = firstIcon?.querySelector("svg");\\n' +
                    'const html = document.documentElement;\\n' +
                    'return {\\n' +
                    '  rectWidth: rect.width, viewportWidth: innerWidth, expectedWidth: Math.min(' + width + ', innerWidth - (family === "native" ? 32 : 56)),\\n' +
                    '  radius: style.borderTopLeftRadius, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],\\n' +
                    '  controlCount: controls.length, badRadii,\\n' +
                    '  modalOverflow: panel.scrollWidth - panel.clientWidth, documentOverflow: Math.max(html.scrollWidth - html.clientWidth, document.body.scrollWidth - document.body.clientWidth),\\n' +
                    '  inputInset: inputRect ? inputRect.left - rect.left : null, expectedInset,\\n' +
                    '  formRightInset: form ? rect.right - form.getBoundingClientRect().right : null, expectedRightInset: number(style.paddingRight) + number(style.borderRightWidth),\\n' +
                    '  liveFieldCount: panel.querySelectorAll("#iptv-source-name, #iptv-playlist-url, #iptv-epg-url").length,\\n' +
                    '  livePlaylistRightInset: livePlaylist ? rect.right - livePlaylist.getBoundingClientRect().right : null,\\n' +
                    '  iconGroupInset: iconGroup ? iconGroup.getBoundingClientRect().left - rect.left : null,\\n' +
                    '  iconRadius: firstIcon ? getComputedStyle(firstIcon).borderTopLeftRadius : null,\\n' +
                    '  iconSvgSize: firstIconSvg ? [firstIconSvg.getBoundingClientRect().width, firstIconSvg.getBoundingClientRect().height] : null,\\n' +
                    '  nestedSettingsPanels: panel.querySelectorAll(".settings-panel, .settings-panel-soft").length,\\n' +
                    '};\\n' +
                    '})()');
                  assert.equal(result.error, undefined, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(Math.abs(result.rectWidth - result.expectedWidth) <= 2, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.equal(result.radius, '20px', JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.deepEqual(result.padding, ['20px', '20px', '20px', '20px'], JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(result.controlCount >= 5, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.deepEqual(result.badRadii, [], JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(result.modalOverflow <= 1, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(result.documentOverflow <= 1, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(Math.abs(result.inputInset - result.expectedInset) <= 1.5, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.ok(Math.abs(result.formRightInset - result.expectedRightInset) <= 1.5, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  assert.equal(result.nestedSettingsPanels, 0, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  if (family === 'native') {
                    assert.equal(result.liveFieldCount, 3, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                    assert.ok(Math.abs(result.iconGroupInset - result.expectedInset) <= 1.5, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                    assert.equal(result.iconRadius, '10px', JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                    assert.deepEqual(result.iconSvgSize, [16, 16], JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                    assert.ok(Math.abs(result.livePlaylistRightInset - result.expectedRightInset) <= 1.5, JSON.stringify({ family, theme, homeStyle, viewportWidth, width, result }));
                  }
                }

                const panelSelector = family === 'native' ? '.fixture-native-dialog' : '[data-testid="v2-panel-marker"]';
                const dialogContainsActive = () => evaluate(
                  family === 'native'
                    ? '(() => { const panel = document.querySelector(".fixture-native-dialog"); return Boolean(panel && panel.contains(document.activeElement)); })()'
                    : '(() => { const panel = document.querySelector("[data-testid=\\"v2-panel-marker\\"]")?.closest("[role=dialog]"); return Boolean(panel && panel.contains(document.activeElement)); })()',
                );
                for (let round = 0; round < 2; round++) {
                  if (round > 0) {
                    await evaluate('document.getElementById(' + JSON.stringify(trigger) + ').focus(); document.getElementById(' + JSON.stringify(trigger) + ').click()');
                    await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
                  }
                  const first = await evaluate(family === 'native'
                    ? 'document.querySelector(".fixture-native-dialog input:not([type=radio])")?.id'
                    : 'document.querySelector("#stremio-manifest-url")?.id');
                  assert.ok(first, JSON.stringify({ family, round, first }));
                  assert.equal(await dialogContainsActive(), true, JSON.stringify({ family, round, stage: 'initial-focus' }));
                  await evaluate('document.getElementById(' + JSON.stringify('background-focus-target') + ').focus()');
                  assert.equal(await dialogContainsActive(), true, JSON.stringify({ family, round, stage: 'background-focus' }));
                  await evaluate(family === 'native'
                    ? '(() => { const panel = document.querySelector(".fixture-native-dialog"); const list = [...panel.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])")]; list[0].focus(); })()'
                    : '(() => { const panel = document.querySelector("[data-testid=\\"v2-panel-marker\\"]")?.closest("[role=dialog]"); const list = [...panel.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])")]; list[0].focus(); })()');
                  await key('Tab', 8);
                  assert.equal(await dialogContainsActive(), true, JSON.stringify({ family, round, stage: 'shift-tab-wrap' }));
                  const lastIsFocused = await evaluate(family === 'native'
                    ? '(() => { const panel = document.querySelector(".fixture-native-dialog"); const list = [...panel.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])")]; return document.activeElement === list[list.length - 1]; })()'
                    : '(() => { const panel = document.querySelector("[data-testid=\\"v2-panel-marker\\"]")?.closest("[role=dialog]"); const list = [...panel.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])")]; return document.activeElement === list[list.length - 1]; })()');
                  assert.equal(lastIsFocused, true, JSON.stringify({ family, round, stage: 'shift-tab-wrap' }));
                  await key('Tab');
                  const firstIsFocused = await evaluate(family === 'native'
                    ? '(() => { const panel = document.querySelector(".fixture-native-dialog"); return document.activeElement === panel.querySelector("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])"); })()'
                    : '(() => { const panel = document.querySelector("[data-testid=\\"v2-panel-marker\\"]")?.closest("[role=dialog]"); return document.activeElement === panel.querySelector("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\\"-1\\"])"); })()');
                  assert.equal(firstIsFocused, true, JSON.stringify({ family, round, stage: 'tab-wrap' }));
                  await key('Escape');
                  await evaluate('new Promise(resolve => setTimeout(resolve, 60))');
                  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(panelSelector) + ') === null'), true);
                  assert.equal(await evaluate('document.activeElement.id'), trigger, JSON.stringify({ family, round, stage: 'focus-restore' }));
                }
              }
            }
          }
        }

        const calls = await evaluate('window.__settingsModalApiCalls.slice()');
        // Opening and closing the add-only Live TV form must not call the desktop API.
        assert.deepEqual(calls, [], JSON.stringify({ calls }));
        process.stdout.write('settings-modals-browser-passed\\n');
      } finally {
        if (!window.isDestroyed()) window.destroy();
      }
    }).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
  `);

  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(require('electron') as string, [script], { env, timeout: 80_000 });
    assert.match(result.stdout, /settings-modals-browser-passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
