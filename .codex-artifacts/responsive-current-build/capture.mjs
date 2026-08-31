import { readFile, writeFile } from 'node:fs/promises';

const pageUrl = 'http://127.0.0.1:3847/app/';
const builtRendererRoot = new URL('../../apps/desktop/.vite/renderer/main_window/', import.meta.url);
const captures = [
  { name: 'phone-390x844', width: 390, height: 844, deviceScaleFactor: 1 },
  { name: 'tablet-768x1024', width: 768, height: 1024, deviceScaleFactor: 1 },
  { name: 'landscape-844x390', width: 844, height: 390, deviceScaleFactor: 1 },
  { name: 'zoom-200-phone', width: 195, height: 422, deviceScaleFactor: 2 },
  { name: 'zoom-200-phone-scrolled', width: 195, height: 422, deviceScaleFactor: 2, scrollY: 220 },
];

const target = await fetch(`http://127.0.0.1:9223/json/new?${encodeURIComponent(pageUrl)}`, {
  method: 'PUT',
}).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Fetch.requestPaused') {
    void fulfillBuiltRendererRequest(message.params);
    return;
  }
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

async function fulfillBuiltRendererRequest(params) {
  const requestUrl = new URL(params.request.url);
  const relativePath = requestUrl.pathname === '/app' || requestUrl.pathname === '/app/'
    ? 'index.html'
    : decodeURIComponent(requestUrl.pathname.slice('/app/'.length));
  if (!relativePath || relativePath.includes('..')) {
    await send('Fetch.continueRequest', { requestId: params.requestId });
    return;
  }
  try {
    const content = await readFile(new URL(relativePath, builtRendererRoot));
    const extension = relativePath.split('.').pop();
    const contentType = extension === 'html' ? 'text/html; charset=utf-8'
      : extension === 'css' ? 'text/css; charset=utf-8'
        : extension === 'js' ? 'text/javascript; charset=utf-8'
          : extension === 'svg' ? 'image/svg+xml'
            : 'application/octet-stream';
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: contentType },
        { name: 'Cache-Control', value: 'no-store' },
        { name: 'X-Loom-Capture-Source', value: 'production-bundle' },
      ],
      body: content.toString('base64'),
    });
  } catch {
    await send('Fetch.continueRequest', { requestId: params.requestId });
  }
}

await send('Page.enable');
await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3847/app*', requestStage: 'Request' }] });

const results = [];
for (const capture of captures) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: capture.width,
    height: capture.height,
    deviceScaleFactor: capture.deviceScaleFactor,
    mobile: true,
    screenWidth: capture.width,
    screenHeight: capture.height,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: pageUrl });
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  if (capture.scrollY) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.loom-modern-home')?.scrollTo(0, ${capture.scrollY})`,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const evaluation = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      client: document.documentElement.dataset.loomClient || '',
      readyState: document.readyState,
      innerWidth,
      innerHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY,
      bodyScrollWidth: document.body.scrollWidth,
      homeScroller: (() => {
        const element = document.querySelector('.loom-modern-home');
        return element ? {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        } : null;
      })(),
      rootChildren: document.getElementById('root')?.childElementCount || 0,
      bodyText: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220),
      narrowStyles: ['.loom-modern-hero-meta', '.loom-modern-header nav a', '.loom-modern-hero-copy']
        .map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, missing: true };
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            selector,
            left: Math.round(rect.left * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            fontSize: style.fontSize,
            flexWrap: style.flexWrap,
            justifyContent: style.justifyContent,
            overflow: style.overflow,
            textAlign: style.textAlign,
            whiteSpace: style.whiteSpace,
            transform: style.transform,
          };
        }),
      assets: [...document.querySelectorAll('script[src], link[href]')]
        .map((element) => element.src || element.href)
        .filter((name) => name.includes('/assets/index-')),
    })`,
    returnByValue: true,
  });
  const metrics = JSON.parse(evaluation.result.value);
  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(new URL(`${capture.name}.png`, import.meta.url), Buffer.from(screenshot.data, 'base64'));
  results.push({ capture, metrics });
}

await send('Emulation.setDeviceMetricsOverride', {
  width: 768,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: 768,
  screenHeight: 720,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Runtime.evaluate', {
  expression: `(() => {
    document.querySelectorAll('a, button, input, select, textarea, [tabindex]').forEach((element) => {
      element.tabIndex = -1;
    });
    [...document.body.children].forEach((element) => { element.inert = true; });
    document.getElementById('loomFocusEvidence')?.remove();
    const fixture = document.createElement('div');
    fixture.id = 'loomFocusEvidence';
    fixture.className = 'loom-app-shell';
    fixture.style.cssText = 'position:fixed;z-index:99999;left:16px;top:16px;display:flex;gap:16px;padding:16px;background:var(--loom-bg)';
    fixture.innerHTML = [
      '<button id="focusButton" type="button">Button</button>',
      '<input id="focusDropdown" class="loom-dropdown-search-input" aria-label="Dropdown search">',
      '<div class="loom-library-search-control"><input id="focusLibrary" aria-label="Library search"></div>',
      '<div class="loom-modern-search-control"><input id="focusModern" class="loom-modern-search-input" aria-label="Modern search"></div>',
    ].join('');
    document.body.append(fixture);
    fixture.inert = false;
    fixture.querySelectorAll('button, input').forEach((element) => { element.tabIndex = 0; });
    document.body.tabIndex = -1;
    document.body.focus();
  })()`,
});

const focusModes = {};
for (const mode of ['dark', 'light']) {
  await send('Runtime.evaluate', {
    expression: `document.documentElement.dataset.theme = '${mode}'; document.documentElement.dataset.homeStyle = 'modern'; document.body.focus();`,
  });
  focusModes[mode] = [];
  for (let index = 0; index < 4; index += 1) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
    });
    const focus = await send('Runtime.evaluate', {
      expression: `(() => {
        const element = document.activeElement;
        const direct = element instanceof HTMLElement ? getComputedStyle(element) : null;
        const composite = element?.closest('.loom-library-search-control, .loom-modern-search-control');
        const container = composite ? getComputedStyle(composite) : null;
        return {
          id: element?.id || '',
          focusVisible: element instanceof HTMLElement ? element.matches(':focus-visible') : false,
          direct: direct ? {
            outlineStyle: direct.outlineStyle,
            outlineWidth: direct.outlineWidth,
            outlineColor: direct.outlineColor,
            boxShadow: direct.boxShadow,
          } : null,
          container: container ? {
            outlineStyle: container.outlineStyle,
            outlineWidth: container.outlineWidth,
            outlineColor: container.outlineColor,
            boxShadow: container.boxShadow,
          } : null,
        };
      })()`,
      returnByValue: true,
    });
    focusModes[mode].push(focus.result.value);
  }
}

await writeFile(
  new URL('../medium-verification/desktop-renderer-focus-evidence.json', import.meta.url),
  `${JSON.stringify({
    assets: results.at(-1)?.metrics.assets.map((asset) => asset.split('/').pop()) || [],
    browser: await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }).then((value) => value.result.value),
    modes: focusModes,
  }, null, 2)}\n`,
);

await writeFile(
  new URL('capture-metrics.json', import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(JSON.stringify(results.map(({ capture, metrics }) => ({
  name: capture.name,
  viewport: `${metrics.innerWidth}x${metrics.innerHeight}`,
  document: `${metrics.scrollWidth}x${metrics.scrollHeight}`,
  bodyScrollWidth: metrics.bodyScrollWidth,
  scrollY: metrics.scrollY,
  homeScroller: metrics.homeScroller,
  assets: metrics.assets.map((asset) => asset.split('/').pop()),
})), null, 2));
socket.close();
