import assert from 'node:assert/strict';
import test from 'node:test';

import { windowChromeOptions } from '../src/main/windowChrome.ts';

test('Windows and Linux use the native frame and application menu chrome', () => {
  assert.deepEqual(windowChromeOptions('win32'), { frame: true });
  assert.deepEqual(windowChromeOptions('linux'), { frame: true });
});

test('macOS keeps its inset traffic-light title bar', () => {
  assert.deepEqual(windowChromeOptions('darwin'), {
    frame: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
  });
});
