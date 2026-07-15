export type PlaybackFailureCode =
  | 'DESKTOP_UNREACHABLE'
  | 'DESKTOP_AUTHORIZATION_FAILED'
  | 'LAN_ADDRESS_UNAVAILABLE'
  | 'MEDIA_NOT_FOUND'
  | 'SUBTITLE_NOT_FOUND'
  | 'TRANSCODER_UNAVAILABLE'
  | 'TRANSCODE_TIMEOUT'
  | 'TRANSCODE_FAILED'
  | 'STREAM_START_FAILED'
  | 'PLAYBACK_LOAD_FAILED';

export type PlaybackFailure = {
  code: PlaybackFailureCode;
  message: string;
  retryable: boolean;
};

export type PlaybackErrorPayload = {
  code?: string;
  error?: string;
  retryable?: boolean;
};

export type PlaybackRecoveryAction = {
  description: string;
  label: string;
};

const FAILURE_DEFAULTS: Record<PlaybackFailureCode, Omit<PlaybackFailure, 'code'>> = {
  DESKTOP_UNREACHABLE: {
    message: 'The mobile app could not reach Loom Media Server. Make sure the desktop is online and on the same network.',
    retryable: true,
  },
  DESKTOP_AUTHORIZATION_FAILED: {
    message: 'This device is no longer authorized by Loom Media Server. Reconnect it from the pairing screen.',
    retryable: false,
  },
  LAN_ADDRESS_UNAVAILABLE: {
    message: 'The desktop network address is unavailable. Restart Local Network Sharing on the desktop, then retry.',
    retryable: true,
  },
  MEDIA_NOT_FOUND: {
    message: 'This file is no longer available at its saved location.',
    retryable: true,
  },
  SUBTITLE_NOT_FOUND: {
    message: 'The selected subtitle file is no longer available at its saved location.',
    retryable: true,
  },
  TRANSCODER_UNAVAILABLE: {
    message: 'The desktop transcoder is unavailable. Restart Loom Media Server or repair the desktop installation.',
    retryable: false,
  },
  TRANSCODE_TIMEOUT: {
    message: 'The desktop took too long to prepare this stream. Retry, or choose a different audio or subtitle track.',
    retryable: true,
  },
  TRANSCODE_FAILED: {
    message: 'The desktop could not convert this file for mobile playback. Retry, or choose a different audio or subtitle track.',
    retryable: true,
  },
  STREAM_START_FAILED: {
    message: 'The desktop could not start this mobile stream. Check Loom Media Server and retry.',
    retryable: true,
  },
  PLAYBACK_LOAD_FAILED: {
    message: 'This device could not load the prepared stream. Retry playback from the current position.',
    retryable: true,
  },
};

function isPlaybackFailureCode(value: string | undefined): value is PlaybackFailureCode {
  return Boolean(value && Object.prototype.hasOwnProperty.call(FAILURE_DEFAULTS, value));
}

function failure(code: PlaybackFailureCode, message?: string, retryable?: boolean): PlaybackFailure {
  const defaults = FAILURE_DEFAULTS[code];
  return {
    code,
    message: message?.trim() || defaults.message,
    retryable: retryable ?? defaults.retryable,
  };
}

export function playbackFailureFromResponse(status: number, payload: PlaybackErrorPayload = {}): PlaybackFailure {
  if (isPlaybackFailureCode(payload.code)) {
    return failure(payload.code, payload.error, payload.retryable);
  }

  if (status === 401 || status === 403) {
    return failure('DESKTOP_AUTHORIZATION_FAILED');
  }
  if (status === 404) {
    return failure('MEDIA_NOT_FOUND', payload.error);
  }
  return failure('STREAM_START_FAILED', payload.error);
}

export function playbackFailureFromUnknown(error: unknown): PlaybackFailure {
  if (error instanceof TypeError) return failure('DESKTOP_UNREACHABLE');
  return failure('STREAM_START_FAILED');
}

export function playbackLoadFailure(): PlaybackFailure {
  return failure('PLAYBACK_LOAD_FAILED');
}

export function recoveryActionFor(failureValue: PlaybackFailure): PlaybackRecoveryAction | null {
  if (!failureValue.retryable) return null;

  if (failureValue.code === 'MEDIA_NOT_FOUND' || failureValue.code === 'SUBTITLE_NOT_FOUND') {
    return {
      label: 'Reconnect NAS & retry',
      description: 'Reconnect the NAS share on the desktop first, then retry this stream.',
    };
  }

  if (failureValue.code === 'DESKTOP_UNREACHABLE' || failureValue.code === 'LAN_ADDRESS_UNAVAILABLE') {
    return {
      label: 'Reconnect & retry',
      description: 'Confirm the desktop is online and Local Network Sharing is running, then retry.',
    };
  }

  return {
    label: 'Retry',
    description: 'Retry the stream without leaving the player.',
  };
}

export async function restorePortraitWithRetry(
  lockPortrait: () => Promise<void>,
  unlockOrientation?: () => Promise<void>,
  attempts = 3,
): Promise<boolean> {
  const maximumAttempts = Math.max(1, attempts);

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      await lockPortrait();
      return true;
    } catch {
      if (attempt === maximumAttempts - 1 || !unlockOrientation) continue;
      try {
        await unlockOrientation();
      } catch {
        // A failed reset should not prevent the next explicit portrait lock.
      }
    }
  }

  return false;
}
