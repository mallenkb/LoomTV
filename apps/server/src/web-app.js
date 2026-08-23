import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSetupRedirectGuard } from './setup-page.js';

export const WEB_APP_PATH = '/app/';
export const WEB_APP_HLS_PATH = '/app/hls.min.js';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_APP_HTML_PATH = path.resolve(MODULE_DIR, 'web-app.html');
const require = createRequire(import.meta.url);
const DEFAULT_HLS_PATH = (() => {
  try { return require.resolve('hls.js/dist/hls.min.js'); } catch { return null; }
})();

const FALLBACK_WEB_APP = '<!doctype html><html lang="en"><meta charset="utf-8"><title>LoomTV</title><body><p>LoomTV web client is unavailable.</p></body></html>';

export function createWebAppPage(options = {}) {
  const htmlProvider = options.getHtml || (() => fs.readFile(options.htmlPath || DEFAULT_WEB_APP_HTML_PATH, 'utf8').catch(() => FALLBACK_WEB_APP));
  const hlsProvider = options.getHls || (() => DEFAULT_HLS_PATH ? fs.readFile(DEFAULT_HLS_PATH) : Promise.reject(Object.assign(new Error('HLS runtime is not installed.'), { code: 'ENOENT' })));
  const setupGuard = createSetupRedirectGuard(options.getSetupStatus, 'app');
  return async function handleWebApp(req, res) {
    const pathname = new URL(req.url || '/', 'http://loomtv.local').pathname;
    const isHtml = pathname === '/app' || pathname === WEB_APP_PATH;
    const isHls = pathname === WEB_APP_HLS_PATH;
    if (!isHtml && !isHls) return false;
    // A server with no owner has nothing to show here yet.
    if (isHtml && (req.method === 'GET' || req.method === 'HEAD') && await setupGuard(req, res)) return true;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = JSON.stringify({ ok: false, error: 'method_not_allowed' });
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    }
    let body;
    try { body = isHls ? await hlsProvider() : await htmlProvider(); } catch {
      if (isHls) {
        res.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'hls_runtime_unavailable' }));
        return true;
      }
      body = FALLBACK_WEB_APP;
    }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': isHls ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
  };
}
