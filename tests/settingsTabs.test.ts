import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  nextSettingsSection,
  remoteLibraryRefreshIdentity,
} from '../src/lib/settingsTabs.ts';

const settingsPageSource = () => readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
const mainProcessSource = () => readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const stylesheetSource = () => readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('settings tab selection keeps the current section when the selected tab is already active', () => {
  assert.equal(nextSettingsSection('network', 'network'), 'network');
  assert.equal(nextSettingsSection('library', 'playback'), 'playback');
});

test('settings tab selection is handled as an urgent UI update', () => {
  const source = settingsPageSource();

  assert.equal(
    source.includes('startTransition'),
    false,
    'Settings tab clicks should update the active section synchronously instead of being deferred behind background work.',
  );
});

test('settings page defers Electron-only status probes until their tabs are active', () => {
  const source = settingsPageSource();
  const settingsLoadIndex = source.indexOf('desktopApi.getSettings()');
  const mountEffectStart = source.lastIndexOf('useEffect', settingsLoadIndex);
  const mountEffectEnd = source.indexOf('\n  }, []);', settingsLoadIndex);
  const mountEffect = mountEffectStart >= 0 && mountEffectEnd >= 0
    ? source.slice(mountEffectStart, mountEffectEnd)
    : '';

  assert.notEqual(mountEffect, '', 'Expected to find the Settings mount effect.');
  assert.equal(
    mountEffect.includes('refreshLocalNetworkStatus'),
    false,
    'Local network status should not be probed when Settings first mounts.',
  );
  assert.equal(
    mountEffect.includes('checkFFmpeg'),
    false,
    'FFmpeg status should not be probed when Settings first mounts.',
  );
  assert.equal(
    mountEffect.includes('getUpdateState'),
    false,
    'Update state should not be probed when Settings first mounts.',
  );
});

test('network status IPC avoids synchronous Wi-Fi name probing', () => {
  const source = mainProcessSource();
  const handlerStart = source.indexOf("ipcMain.handle('network:status'");
  const handlerEnd = source.indexOf('\n});', handlerStart);
  const handler = handlerStart >= 0 && handlerEnd >= 0 ? source.slice(handlerStart, handlerEnd) : '';

  assert.notEqual(handler, '', 'Expected to find the network status IPC handler.');
  assert.equal(
    handler.includes('getLocalNetworkName()'),
    false,
    'The renderer network status IPC should not synchronously shell out for the Wi-Fi name.',
  );
});

test('FFmpeg status IPC resolves the binary path once', () => {
  const source = mainProcessSource();
  const handlerStart = source.indexOf("ipcMain.handle('media:ffmpeg-available'");
  const handlerEnd = source.indexOf('\n});', handlerStart);
  const handler = handlerStart >= 0 && handlerEnd >= 0 ? source.slice(handlerStart, handlerEnd) : '';
  const findCalls = handler.match(/findFFmpeg\(\)/g) || [];

  assert.notEqual(handler, '', 'Expected to find the FFmpeg availability IPC handler.');
  assert.equal(findCalls.length, 1, 'The FFmpeg availability IPC handler should not run discovery twice.');
});

test('settings tab strip opts out of the macOS drag area', () => {
  const source = settingsPageSource();
  const tabStripStart = source.indexOf('{SETTINGS_SECTIONS.map');
  const tabStripOpening = source.lastIndexOf('className="', tabStripStart);
  const tabStripClass = tabStripOpening >= 0
    ? source.slice(tabStripOpening, source.indexOf('"', tabStripOpening + 'className="'.length + 1))
    : '';

  assert.match(tabStripClass, /loom-no-drag/, 'The Settings tab strip must remain clickable inside the top drag band.');
});

test('macOS drag regions never claim interactive controls', () => {
  const source = stylesheetSource();

  assert.match(
    source,
    /body\.platform-darwin\s+:where\([^)]*button[^)]*input[^)]*select[^)]*textarea/s,
    'Interactive controls should opt out of macOS window dragging.',
  );
});

test('remote library refresh identity ignores refreshed library payload changes', () => {
  const first = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-a',
    deviceToken: 'token-a',
    libraryEtag: 'etag-1',
    library: { movies: [{ id: 'movie-1' }] },
  });
  const refreshed = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-a',
    deviceToken: 'token-a',
    libraryEtag: 'etag-2',
    library: { movies: [{ id: 'movie-1' }, { id: 'movie-2' }] },
  });
  const reconnected = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-b',
    deviceToken: 'token-b',
    libraryEtag: 'etag-2',
    library: { movies: [{ id: 'movie-1' }] },
  });

  assert.equal(first, refreshed);
  assert.notEqual(first, reconnected);
});
