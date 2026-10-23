import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { resolveSafeProviderAddress } from './safeFetch.ts';

export type SafeMediaResponse = { response: IncomingMessage; url: string };

async function resolveAddress(url: URL, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let abort: () => void = () => { /* Assigned before a listener is installed. */ };
  try {
    return await Promise.race([
      resolveSafeProviderAddress(url),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Media destination lookup was cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}

/**
 * Keep DNS validation and the actual socket on the same address. Unlike
 * safeFetch's JSON transport, return the paused response without buffering it.
 * Only GET/HEAD are supported; no ambient cookies, proxy, or client credentials.
 */
export async function openSafeMediaStream(input: string, options: {
  signal: AbortSignal;
  method?: 'GET' | 'HEAD';
  range?: string;
  headers?: Readonly<Record<string, string>>;
}): Promise<SafeMediaResponse> {
  let url = new URL(input);
  const initialOrigin = url.origin;
  for (let hop = 0; hop <= 4; hop += 1) {
    options.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    deadline.unref();
    let response: IncomingMessage;
    try {
      const address = await resolveAddress(url, signal);
      signal.throwIfAborted();
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = https.request({
          hostname: address,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          servername: url.hostname.replace(/^\[|\]$/g, ''),
          method: options.method || 'GET',
          agent: false,
          signal,
          lookup: (_hostname, _options, callback) => callback(null, address, net.isIPv4(address) ? 4 : 6),
          headers: {
            // Provider headers apply only to the exact original authority.
            ...(url.origin === initialOrigin ? options.headers : {}),
            Host: url.host,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            ...(options.range ? { Range: options.range } : {}),
          },
        }, incoming => {
          incoming.setTimeout(30_000, () => incoming.destroy(new Error('Media response timed out.')));
          // Always consume transport errors, including cancellation before the
          // relay has attached its iterator or pipe.
          incoming.on('error', () => { /* The request or relay handles transport failure. */ });
          resolve(incoming);
        });
        request.on('error', () => reject(new Error('The media provider could not be reached.')));
        request.end();
      });
    } finally { clearTimeout(deadline); }
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || hop === 4) throw new Error('The media provider redirected too many times.');
      url = new URL(location, url);
      continue;
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') {
      response.destroy();
      throw new Error('Compressed media transport responses are not supported.');
    }
    return { response, url: url.toString() };
  }
  throw new Error('The media provider redirected too many times.');
}
