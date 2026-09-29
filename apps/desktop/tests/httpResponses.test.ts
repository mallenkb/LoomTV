import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { HttpBodyError, readJsonBody } from '../src/main/httpResponses.ts';

function requestStream(headers: IncomingMessage['headers'] = {}): IncomingMessage {
  const stream = new PassThrough() as PassThrough & Partial<IncomingMessage>;
  stream.headers = headers;
  return stream as IncomingMessage;
}

test('bounded JSON bodies accept objects and reject non-object JSON', async () => {
  const valid = requestStream();
  const validResult = readJsonBody(valid, { maxBytes: 64 });
  valid.end('{"ok":true}');
  assert.deepEqual(await validResult, { ok: true });

  const invalid = requestStream();
  const invalidResult = readJsonBody(invalid, { maxBytes: 64 });
  invalid.end('[1,2,3]');
  await assert.rejects(invalidResult, (error: unknown) => error instanceof HttpBodyError && error.statusCode === 400);
});

test('bounded JSON bodies reject declared and streamed payloads over the limit', async () => {
  const declared = requestStream({ 'content-length': '128' });
  await assert.rejects(
    readJsonBody(declared, { maxBytes: 16 }),
    (error: unknown) => error instanceof HttpBodyError && error.statusCode === 413,
  );

  const streamed = requestStream();
  const streamedResult = readJsonBody(streamed, { maxBytes: 16 });
  streamed.end('{"value":"this is much too long"}');
  await assert.rejects(streamedResult, (error: unknown) => error instanceof HttpBodyError && error.statusCode === 413);
});

test('stalled JSON bodies time out', async () => {
  const stalled = requestStream();
  await assert.rejects(
    readJsonBody(stalled, { timeoutMs: 5 }),
    (error: unknown) => error instanceof HttpBodyError && error.statusCode === 408,
  );
});
