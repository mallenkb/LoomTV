import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readBoundedUtf8File } from './boundedTextFile.ts';

const MAX_SIDECAR_SUBTITLE_BYTES = 8 * 1024 * 1024;

type CorsDependencies = {
  ALLOWED_CORS_ORIGINS: ReadonlySet<string>;
  LOCAL_ACCESS_HEADER: string;
  allowedCorsOrigin: (origin: string | undefined, allowedOrigins: ReadonlySet<string>) => string | null;
};

export function readBoundedUtf8Subtitle(filePath: string, signal: AbortSignal): Promise<string> {
  return readBoundedUtf8File(filePath, { maxBytes: MAX_SIDECAR_SUBTITLE_BYTES, signal });
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function writeLanLandingPage(
  res: http.ServerResponse,
  details: { baseUrl: string | null; deviceName: string; fallbackPort: number; sharingEnabled: boolean },
): void {
  const baseUrl = details.baseUrl || `http://127.0.0.1:${details.fallbackPort}`;
  const statusCopy = details.sharingEnabled
    ? 'Local Network Sharing is on. Library and stream endpoints stay private until a device pairs with the code shown in desktop Settings.'
    : 'Local Network Sharing is off. Turn it on in desktop Settings before pairing a phone or tablet.';
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoomTV</title>
<style>
:root{color-scheme:dark;--bg:#050505;--panel:#101010;--line:#2a2a2a;--text:#fff;--muted:#a4a4a4;--accent:#FC9C03;}
*{box-sizing:border-box;letter-spacing:normal!important}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:grid;place-items:center;padding:24px}
main{width:min(680px,100%);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.38)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.mark{width:38px;height:38px;border-radius:12px;background:var(--accent);display:grid;place-items:center;color:#08101a;font-weight:900}.name{font-size:24px;font-weight:800}
.eyebrow{font-size:12px;font-weight:800;text-transform:uppercase;color:var(--accent);margin-bottom:8px}h1{font-size:clamp(28px,7vw,44px);line-height:1.06;margin:0 0 12px}p{margin:0;color:var(--muted)}
.box{border:1px solid var(--line);border-radius:14px;background:#080808;padding:16px;margin-top:18px}.label{font-size:12px;font-weight:800;text-transform:uppercase;color:#767676;margin-bottom:6px}.value{font:700 18px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
ol{margin:18px 0 0;padding-left:22px;color:var(--muted)}li{margin:8px 0}b{color:var(--text)}footer{margin-top:22px;border-top:1px solid var(--line);padding-top:16px;font-size:13px;color:#7b7b7b}
</style>
</head>
<body>
<main>
<div class="brand"><div class="mark">L</div><div class="name">loomtv</div></div>
<div class="eyebrow">LAN host online</div>
<h1>This is your private LoomTV library.</h1>
<p>${htmlEscape(statusCopy)}</p>
<div class="box"><div class="label">Desktop address</div><div class="value">${htmlEscape(baseUrl)}</div></div>
<ol>
<li>Open <b>LoomTV mobile</b>, not this browser page.</li>
<li>Choose this desktop and tap <b>Connect</b>.</li>
<li>Approve the device in the desktop prompt. If approval is unavailable, use <b>Connect manually</b> with the address and PIN from Settings &gt; Network.</li>
</ol>
<footer>${htmlEscape(details.deviceName)}</footer>
</main>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const WEB_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function serveWebRendererAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  rendererRoot: string,
): void {
  if (reqUrl.pathname === '/app') {
    res.writeHead(302, { Location: '/app/', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(reqUrl.pathname.slice('/app/'.length)) || 'index.html';
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const root = path.resolve(rendererRoot);
  const candidate = path.resolve(root, relativePath);
  const relativeCandidate = path.relative(root, candidate);
  if (relativeCandidate.startsWith('..') || path.isAbsolute(relativeCandidate)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const extension = path.extname(candidate).toLowerCase();
  res.writeHead(200, {
    'Content-Type': WEB_ASSET_CONTENT_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(candidate).pipe(res);
}

export function proxyWebRendererAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  devServerUrl: string,
): void {
  const target = new URL(devServerUrl);
  target.pathname = reqUrl.pathname.startsWith('/app/') ? `/${reqUrl.pathname.slice('/app/'.length)}` : reqUrl.pathname;
  target.search = reqUrl.search;
  const proxyRequest = http.request(target, {
    method: req.method,
    headers: { ...req.headers, host: target.host },
  }, (proxyResponse) => {
    res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    proxyResponse.pipe(res);
  });
  proxyRequest.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('The LoomTV web development server is unavailable.');
  });
  proxyRequest.end();
}

export function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse, deps: CorsDependencies): boolean {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const allowedOrigin = deps.allowedCorsOrigin(origin, deps.ALLOWED_CORS_ORIGINS);
  res.setHeader('Vary', 'Origin');
  if (!allowedOrigin) return !origin;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', `Range, Content-Type, Authorization, If-None-Match, X-Loom-Profile-Api-Version, ${deps.LOCAL_ACCESS_HEADER}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  return true;
}

export function listenWithPortRetries(
  server: http.Server | https.Server,
  initialPort: number,
  host: string,
  label: string,
): Promise<number> {
  const maxAttempts = 20;
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = (port: number) => {
      attempts += 1;
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attempts < maxAttempts && port < 65_535) {
          attempt(port + 1);
          return;
        }
        reject(error.code === 'EADDRINUSE'
          ? new Error(`${label} could not bind after ${attempts} ports from ${initialPort}.`, { cause: error })
          : error);
      };
      server.once('error', onError);
      try {
        server.listen(port, host, () => {
          server.off('error', onError);
          server.on('error', (error) => console.error(`[media-server] ${label} error:`, error));
          resolve(port);
        });
      } catch (error) {
        server.off('error', onError);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    attempt(initialPort);
  });
}
