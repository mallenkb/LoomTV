import { writeFile } from 'node:fs/promises';

const pageUrl = new URL('../../apps/server/src/setup.html', import.meta.url).href;
const target = await fetch(`http://127.0.0.1:9226/json/new?${encodeURIComponent(pageUrl)}`, {
  method: 'PUT',
}).then((response) => response.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result.value;
}

async function key(key, { shift = false } = {}) {
  const modifiers = shift ? 8 : 0;
  const keyCode = key === 'Tab' ? 9 : key === 'Escape' ? 27 : 13;
  const code = key === 'Escape' ? 'Escape' : key;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode,
  });
}

const snapshotExpression = `(() => {
  const active = document.activeElement;
  const style = active instanceof HTMLElement ? getComputedStyle(active) : null;
  return {
    dialogHidden: document.getElementById('folderDialogBackdrop')?.hidden ?? true,
    activeId: active?.id || '',
    activeText: active?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    focusVisible: active instanceof HTMLElement ? active.matches(':focus-visible') : false,
    outlineStyle: style?.outlineStyle || '',
    outlineWidth: style?.outlineWidth || '',
    outlineColor: style?.outlineColor || '',
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: pageUrl });
await new Promise((resolve) => setTimeout(resolve, 700));

await evaluate(`(() => {
  const step = document.getElementById('stepLibraries');
  const sections = document.getElementById('librarySections');
  if (!step || !sections) throw new Error('Libraries step is missing');
  step.hidden = false;
  sections.innerHTML = '<button id="keyboardEvidenceOpener" class="button" type="button" data-add-kind="movies">Add folder</button>';
  const opener = document.getElementById('keyboardEvidenceOpener');
  opener.focus();
  opener.click();
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 100));
const opened = await evaluate(snapshotExpression);
const screenshot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});
await writeFile(
  new URL('desktop-setup-dialog.png', import.meta.url),
  Buffer.from(screenshot.data, 'base64'),
);

await key('Tab', { shift: true });
const wrappedBackward = await evaluate(snapshotExpression);

await key('Tab');
const wrappedForward = await evaluate(snapshotExpression);

await key('Escape');
await new Promise((resolve) => setTimeout(resolve, 100));
const closed = await evaluate(snapshotExpression);

const evidence = {
  environment: {
    browser: await evaluate('navigator.userAgent'),
    pageUrl,
    viewport: await evaluate('`${innerWidth}x${innerHeight}`'),
  },
  opened,
  wrappedBackward,
  wrappedForward,
  closed,
};

await writeFile(
  new URL('desktop-setup-keyboard-evidence.json', import.meta.url),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
socket.close();
