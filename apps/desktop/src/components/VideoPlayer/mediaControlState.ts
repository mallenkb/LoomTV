import type {
  MediaSessionCommandType,
  MediaSessionEngine,
  MediaSessionPlaybackState,
  MediaSessionSnapshot,
} from '@/shared/mediaControlProtocol';

/**
 * Pure helpers that turn player state into a media-session snapshot.
 *
 * Kept out of the hook so the capability mapping and publishing rules can be
 * tested without React.
 */

export type MediaSessionSnapshotInput = {
  sessionId: string;
  state: MediaSessionPlaybackState;
  positionSeconds: number;
  durationSeconds: number;
  rate: number;
  title: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  queueIndex: number;
  queueCount: number;
  canPreviousItem: boolean;
  canNextItem: boolean;
  skipForwardSeconds: number;
  skipBackSeconds: number;
  engine: MediaSessionEngine;
  engineSessionId?: string;
  artworkUrl?: string;
};

/**
 * Which commands the player can service right now.
 *
 * Adapters disable everything absent from this list rather than registering a
 * handler that does nothing, so a system control is greyed out instead of dead.
 * Repeat and shuffle are omitted because LoomTV has no repeat mode to map them
 * onto.
 */
export function supportedMediaSessionCommands(
  input: MediaSessionSnapshotInput,
): MediaSessionCommandType[] {
  const commands: MediaSessionCommandType[] = ['play', 'pause', 'toggle', 'stop', 'setRate'];
  if (input.durationSeconds > 0) commands.push('seekRelative', 'seekAbsolute');
  if (input.canPreviousItem) commands.push('previousItem');
  if (input.canNextItem) commands.push('nextItem');
  return commands;
}

export function buildMediaSessionSnapshot(input: MediaSessionSnapshotInput): MediaSessionSnapshot {
  return {
    sessionId: input.sessionId,
    state: input.state,
    positionSeconds: input.positionSeconds,
    durationSeconds: input.durationSeconds,
    rate: input.rate,
    supportedCommands: supportedMediaSessionCommands(input),
    skipForwardSeconds: input.skipForwardSeconds,
    skipBackSeconds: input.skipBackSeconds,
    title: input.title,
    ...(input.seriesTitle ? { seriesTitle: input.seriesTitle } : {}),
    ...(input.season ? { season: input.season } : {}),
    ...(input.episode ? { episode: input.episode } : {}),
    queueIndex: input.queueIndex,
    queueCount: input.queueCount,
    engine: input.engine,
    ...(input.engineSessionId ? { engineSessionId: input.engineSessionId } : {}),
    ...(input.artworkUrl ? { artworkUrl: input.artworkUrl } : {}),
  };
}
