import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

const CLOSED_RESPONSE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_WRITE_AFTER_END',
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : undefined;
}

export function isClosedResponseError(error: unknown): boolean {
  const code = errorCode(error);
  return Boolean(code && CLOSED_RESPONSE_ERROR_CODES.has(code));
}

export function canWriteResponse(res: ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded && res.writable;
}

/** Keep an abandoned media request from becoming an uncaught main-process error. */
export function handleResponseErrors(res: ServerResponse): void {
  res.on('error', (error) => {
    if (!isClosedResponseError(error)) {
      console.error('Media server response error:', error);
    }
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (!canWriteResponse(res)) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64'),
  };
}

export function redirectToArtworkSource(res: ServerResponse, sourceUrl: string): void {
  if (!canWriteResponse(res)) return;
  res.writeHead(302, {
    Location: sourceUrl,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end();
}

export function safeEndResponse(res: ServerResponse): void {
  if (!canWriteResponse(res)) return;
  try {
    res.end();
  } catch (error) {
    if (!isClosedResponseError(error)) throw error;
  }
}

/**
 * Pipe a producer into an HTTP response and stop it as soon as the client or
 * another completion path closes the response.
 */
export function pipeResponse(source: Readable, res: ServerResponse): void {
  if (!canWriteResponse(res)) {
    source.destroy();
    return;
  }

  const cleanup = () => {
    res.off('close', stopSource);
    res.off('error', stopSource);
    res.off('finish', responseFinished);
    source.off('error', sourceFailed);
  };
  const stopSource = () => {
    cleanup();
    source.unpipe(res);
    if (!source.destroyed) source.destroy();
  };
  const responseFinished = () => {
    cleanup();
    if (!source.readableEnded) {
      source.unpipe(res);
      source.destroy();
    }
  };
  const sourceFailed = () => {
    cleanup();
    safeEndResponse(res);
  };

  res.once('close', stopSource);
  res.once('error', stopSource);
  res.once('finish', responseFinished);
  source.once('error', sourceFailed);
  source.pipe(res);
}
