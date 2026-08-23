import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared first-run setup page.
 *
 * Both the desktop window and a headless browser load this same document, so
 * there is one onboarding design and one client for the setup API. The page
 * itself is dumb: every decision — whether setup is required, which step is
 * next, when it is finished — comes from `/api/v1/setup/state`.
 */

export const SETUP_PATH = '/setup/';
export const SETUP_CONTENT_TYPE = 'text/html; charset=utf-8';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SETUP_HTML_PATH = path.resolve(MODULE_DIR, 'setup.html');

const FALLBACK_SETUP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoomTV setup</title><style>:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#fafafa}
body{display:grid;min-height:100vh;place-items:center;margin:0;padding:24px}main{max-width:560px}h1{margin:0 0 10px;color:#FC9C03}p{line-height:1.6;color:#a3a3a3}code{color:#FC9C03}</style></head>
<body><main><h1>LoomTV setup</h1><p>The setup page asset was not packaged with this server. Copy <code>setup.html</code> next to the server and restart it.</p></main></body></html>`;

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': '0' });
  res.end();
}

/** `?return=admin` survives the round trip so completion lands where you began. */
export function setupReturnTarget(value) {
  return value === 'admin' ? 'admin' : 'app';
}

export function createSetupPage(options = {}) {
  const htmlProvider = options.getHtml
    || (() => fs.readFile(options.htmlPath || DEFAULT_SETUP_HTML_PATH, 'utf8').catch(() => FALLBACK_SETUP_HTML));
  const getSetupStatus = options.getSetupStatus;

  return async function handleSetupPage(req, res) {
    const url = new URL(req.url || '/', 'http://loomtv.local');
    if (url.pathname !== '/setup' && url.pathname !== SETUP_PATH) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = JSON.stringify({ ok: false, error: 'method_not_allowed' });
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    }
    if (url.pathname === '/setup') {
      redirect(res, `${SETUP_PATH}${url.search}`);
      return true;
    }
    // An installation that is already set up never sees this page again.
    if (typeof getSetupStatus === 'function') {
      const status = await getSetupStatus().catch(() => null);
      if (status && !status.required) {
        redirect(res, setupReturnTarget(url.searchParams.get('return')) === 'admin' ? '/admin/' : '/app/');
        return true;
      }
    }
    const body = await htmlProvider().catch(() => FALLBACK_SETUP_HTML);
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': SETUP_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(body),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
  };
}

/**
 * Guard for `/app` and `/admin`: an unclaimed or half-configured server sends
 * every visitor to the one setup flow, tagged with where they started.
 */
export function createSetupRedirectGuard(getSetupStatus, from) {
  if (typeof getSetupStatus !== 'function') return async () => false;
  return async function guard(req, res) {
    const status = await getSetupStatus().catch(() => null);
    if (!status?.required) return false;
    redirect(res, `${SETUP_PATH}?return=${from}`);
    return true;
  };
}
