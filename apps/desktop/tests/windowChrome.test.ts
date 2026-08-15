import assert from 'node:assert/strict';
import test from 'node:test';

import { windowChromeOptions } from '../src/main/windowChrome.ts';

test('Windows and Linux use native controls over the standard menu bar', () => {
  const expected = {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f1f1f', symbolColor: '#f2f2f2', height: 30 },
  };
  assert.deepEqual(windowChromeOptions('win32'), expected);
  assert.deepEqual(windowChromeOptions('linux'), expected);
});

test('macOS keeps its inset traffic-light title bar', () => {
  assert.deepEqual(windowChromeOptions('darwin'), {
    frame: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
  });
});
