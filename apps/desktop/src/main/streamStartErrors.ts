export type StreamStartFailureCode =
  | 'TRANSCODER_UNAVAILABLE'
  | 'TRANSCODE_TIMEOUT'
  | 'TRANSCODE_FAILED'
  | 'STREAM_START_FAILED';

export type StreamStartFailure = {
  code: StreamStartFailureCode;
  error: string;
  retryable: boolean;
};

export function streamStartFailure(error: unknown): StreamStartFailure {
  const detail = error instanceof Error ? error.message : String(error || '');

  if (/ffmpeg is not available/i.test(detail)) {
    return {
      code: 'TRANSCODER_UNAVAILABLE',
      error: 'The desktop transcoder is unavailable. Restart Loom Media Server or repair the desktop installation.',
      retryable: false,
    };
  }

  if (/timed out waiting for the transcode/i.test(detail)) {
    return {
      code: 'TRANSCODE_TIMEOUT',
      error: 'The desktop took too long to prepare this stream. Retry, or choose a different audio or subtitle track.',
      retryable: true,
    };
  }

  if (/transcode process exited|unable to start transcoding|transcode session was replaced/i.test(detail)) {
    return {
      code: 'TRANSCODE_FAILED',
      error: 'The desktop could not convert this file for mobile playback. Retry, or choose a different audio or subtitle track.',
      retryable: true,
    };
  }

  return {
    code: 'STREAM_START_FAILED',
    error: 'The desktop could not start this mobile stream. Check Loom Media Server and retry.',
    retryable: true,
  };
}
