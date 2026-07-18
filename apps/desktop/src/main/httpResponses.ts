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

function isClosedResponseError(error: unknown): boolean {
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

export class HttpBodyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HttpBodyError';
    this.statusCode = statusCode;
  }
}

type ReadJsonBodyOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};

export async function readJsonBody(
  req: IncomingMessage,
  options: ReadJsonBodyOptions = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(new HttpBodyError(`Request body exceeds ${maxBytes} bytes.`, 413));
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new HttpBodyError('Request body timed out.', 408)));
      req.destroy();
    }, timeoutMs);

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        finish(() => reject(new HttpBodyError(`Request body exceeds ${maxBytes} bytes.`, 413)));
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks, byteLength).toString('utf8');
      if (!body) {
        finish(() => resolve({}));
        return;
      }
      try {
        const parsed = JSON.parse(body) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new HttpBodyError('JSON body must be an object.', 400);
        }
        finish(() => resolve(parsed as Record<string, unknown>));
      } catch (error) {
        finish(() => reject(error instanceof HttpBodyError
          ? error
          : new HttpBodyError('Request body is not valid JSON.', 400)));
      }
    });
    req.on('error', (error) => finish(() => reject(error)));
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
