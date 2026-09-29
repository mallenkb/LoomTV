import assert from 'node:assert/strict';
import test from 'node:test';
import { streamStartFailure } from '../src/main/streamStartErrors.ts';

test('reports a missing FFmpeg runtime as a non-retryable desktop repair issue', () => {
  const result = streamStartFailure(new Error('FFmpeg is not available.'));

  assert.equal(result.code, 'TRANSCODER_UNAVAILABLE');
  assert.equal(result.retryable, false);
  assert.match(result.error, /desktop transcoder is unavailable/i);
});

test('reports transcode startup timeouts as retryable', () => {
  const result = streamStartFailure(new Error('Timed out waiting for the transcode to start.'));

  assert.equal(result.code, 'TRANSCODE_TIMEOUT');
  assert.equal(result.retryable, true);
  assert.match(result.error, /retry/i);
});

test('does not expose unknown internal error details to mobile clients', () => {
  const result = streamStartFailure(new Error('/Volumes/private/movie.mkv: secret failure detail'));

  assert.equal(result.code, 'STREAM_START_FAILED');
  assert.doesNotMatch(result.error, /private|secret/i);
});
