import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserWindow, PowerMonitor } from 'electron';
import { installWindowRepaint } from '../src/main/windowRepaint.ts';

function harness() {
  const state = { visible: true, minimized: false, destroyed: false, rendererDestroyed: false, paints: 0 };
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isDestroyed: () => state.destroyed,
    webContents: {
      isDestroyed: () => state.rendererDestroyed,
      invalidate: () => { state.paints += 1; },
    },
  });
  const power = new EventEmitter();
  installWindowRepaint(window as unknown as BrowserWindow, power as unknown as PowerMonitor);
  return { state, window, power };
}

test('returning to a visible window requests a fresh frame', () => {
  const { state, window } = harness();
  window.emit('focus');
  window.emit('show');
  window.emit('restore');
  assert.equal(state.paints, 3);
});

test('wake and unlock redraw the library even without a new window focus event', () => {
  const { state, power } = harness();
  power.emit('resume');
  power.emit('unlock-screen');
  power.emit('user-did-become-active');
  assert.equal(state.paints, 3);
});

test('wake leaves hidden and minimized windows alone until they return', () => {
  const { state, window, power } = harness();
  state.visible = false;
  power.emit('resume');
  state.visible = true;
  state.minimized = true;
  power.emit('unlock-screen');
  assert.equal(state.paints, 0);

  state.minimized = false;
  window.emit('restore');
  assert.equal(state.paints, 1);
});

test('destroyed renderers are ignored and closing removes all wake listeners', () => {
  const { state, window, power } = harness();
  state.rendererDestroyed = true;
  power.emit('resume');
  state.rendererDestroyed = false;
  state.destroyed = true;
  power.emit('resume');
  assert.equal(state.paints, 0);

  window.emit('closed');
  for (const event of ['resume', 'unlock-screen', 'user-did-become-active']) {
    assert.equal(power.listenerCount(event), 0);
  }
  for (const event of ['focus', 'show', 'restore']) assert.equal(window.listenerCount(event), 0);
});
