/**
 * The single system-media-session contract shared by the Electron main process,
 * the preload bridge, and the renderer.
 *
 * LoomTV plays local files through LibVLC or mpv, which bypass Chromium's media
 * pipeline entirely, so the operating system cannot discover the session on its
 * own. Everything here describes the session LoomTV already has open: a command
 * drives the running engine, and a snapshot tells the platform what to display.
 *
 * A command never restarts playback, switches engines, starts a transcode, or
 * calls a metadata provider.
 *
 * This module imports nothing, so the main process, the renderer, and the test
 * runner all use it directly.
 */

/** Commands an operating-system media session can send to the active player. */
export type MediaSessionCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  /** Ends playback and releases the session. It does not close the player window. */
  | { type: 'stop' }
  | { type: 'seekRelative'; offsetSeconds: number }
  | { type: 'seekAbsolute'; positionSeconds: number }
  | { type: 'previousItem' }
  | { type: 'nextItem' }
  | { type: 'setRate'; rate: number };

export type MediaSessionCommandType = MediaSessionCommand['type'];

export const MEDIA_SESSION_COMMAND_TYPES = [
  'play',
  'pause',
  'toggle',
  'stop',
  'seekRelative',
  'seekAbsolute',
  'previousItem',
  'nextItem',
  'setRate',
] as const satisfies ReadonlyArray<MediaSessionCommandType>;

export type MediaSessionPlaybackState = 'playing' | 'paused' | 'stopped';

/** The engine that owns the current session, which decides where a command goes. */
export type MediaSessionEngine = 'libvlc' | 'mpv' | 'chromium';

/**
 * What the platform media session should display and enable.
 *
 * Published on discontinuity only: play, pause, seek, rate change, item change.
 * Every platform interpolates position from elapsed time and rate, so there is
 * no periodic tick.
 */
export type MediaSessionSnapshot = {
  /** Identity of the player session; a new value means a new item. */
  sessionId: string;
  state: MediaSessionPlaybackState;
  positionSeconds: number;
  durationSeconds: number;
  rate: number;
  supportedCommands: MediaSessionCommandType[];
  skipForwardSeconds: number;
  skipBackSeconds: number;
  title: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  queueIndex: number;
  queueCount: number;
  /**
   * Engine currently rendering the media. LibVLC and mpv run in the main
   * process, so their transport commands are dispatched there directly instead
   * of taking a renderer round trip that Chromium's background throttling can
   * delay.
   */
  engine: MediaSessionEngine;
  /** Native engine session id, present for LibVLC and mpv. */
  engineSessionId?: string;
  /**
   * Artwork the renderer knows about, as a URL. The controller resolves it to a
   * local file before publishing; adapters only ever see `artworkPath`.
   */
  artworkUrl?: string;
  /** Local cache path, never a remote URL. Filled in by the controller. */
  artworkPath?: string;
};

export type MediaSessionAdapterKind =
  | 'macos-mediaplayer'
  | 'linux-mpris'
  | 'windows-smtc'
  | 'unsupported';

/**
 * The small diagnostic the renderer receives when it claims the session.
 *
 * There is no Chromium Media Session path inside the desktop app, so this is
 * reporting only: it never selects a second owner.
 */
export type MediaSessionDiagnostics = {
  platform: string;
  adapter: MediaSessionAdapterKind;
  /** A platform media session is publishing and receiving commands. */
  active: boolean;
  /** Short, user-safe explanation when no adapter is running. */
  reason?: string;
};

const MAX_TEXT_LENGTH = 240;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const MIN_RATE = 0.05;
const MAX_RATE = 16;
const DEFAULT_SKIP_SECONDS = 10;
const MAX_SKIP_SECONDS = 600;
const MAX_QUEUE_COUNT = 100_000;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : fallback;
}

function normalizeSeconds(value: unknown, max = MAX_DURATION_SECONDS): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(max, parsed);
}

function normalizeSkipSeconds(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SKIP_SECONDS;
  return Math.min(MAX_SKIP_SECONDS, parsed);
}

export function normalizeRate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, parsed));
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(MAX_QUEUE_COUNT, Math.floor(parsed));
}

function normalizeOptionalIndex(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function isMediaSessionCommandType(value: unknown): value is MediaSessionCommandType {
  return typeof value === 'string'
    && (MEDIA_SESSION_COMMAND_TYPES as ReadonlyArray<string>).includes(value);
}

function normalizeSupportedCommands(value: unknown): MediaSessionCommandType[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<MediaSessionCommandType>();
  for (const entry of value) {
    if (isMediaSessionCommandType(entry)) seen.add(entry);
  }
  return MEDIA_SESSION_COMMAND_TYPES.filter((type) => seen.has(type));
}

function normalizeEngine(value: unknown): MediaSessionEngine {
  return value === 'libvlc' || value === 'mpv' ? value : 'chromium';
}

function normalizeState(value: unknown): MediaSessionPlaybackState {
  return value === 'playing' || value === 'stopped' ? value : 'paused';
}

/**
 * Reduce anything the renderer sent to a snapshot every adapter can publish.
 *
 * Platform APIs reject NaN, negative durations, and out-of-range rates, so this
 * happens once here rather than in each adapter.
 */
export function normalizeMediaSessionSnapshot(input: unknown): MediaSessionSnapshot {
  const raw = readRecord(input);
  const durationSeconds = normalizeSeconds(raw.durationSeconds);
  const positionSeconds = durationSeconds > 0
    ? Math.min(durationSeconds, normalizeSeconds(raw.positionSeconds))
    : normalizeSeconds(raw.positionSeconds);
  const season = normalizeOptionalIndex(raw.season);
  const episode = normalizeOptionalIndex(raw.episode);
  const seriesTitle = normalizeText(raw.seriesTitle);
  const engineSessionId = normalizeText(raw.engineSessionId);
  const artworkUrl = typeof raw.artworkUrl === 'string' ? raw.artworkUrl.slice(0, 2048) : '';
  const artworkPath = typeof raw.artworkPath === 'string' ? raw.artworkPath.slice(0, 4096) : '';

  return {
    sessionId: normalizeText(raw.sessionId, 'loomtv-player'),
    state: normalizeState(raw.state),
    positionSeconds,
    durationSeconds,
    rate: normalizeRate(raw.rate),
    supportedCommands: normalizeSupportedCommands(raw.supportedCommands),
    skipForwardSeconds: normalizeSkipSeconds(raw.skipForwardSeconds),
    skipBackSeconds: normalizeSkipSeconds(raw.skipBackSeconds),
    title: normalizeText(raw.title, 'LoomTV'),
    ...(seriesTitle ? { seriesTitle } : {}),
    ...(season ? { season } : {}),
    ...(episode ? { episode } : {}),
    queueIndex: normalizeCount(raw.queueIndex),
    queueCount: normalizeCount(raw.queueCount),
    engine: normalizeEngine(raw.engine),
    ...(engineSessionId ? { engineSessionId } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    ...(artworkPath ? { artworkPath } : {}),
  };
}

/**
 * Reduce an untrusted command payload to a well-formed command, or null.
 *
 * Adapters build these from platform callbacks, so a malformed payload must be
 * dropped rather than reaching the player.
 */
export function normalizeMediaSessionCommand(input: unknown): MediaSessionCommand | null {
  const raw = readRecord(input);
  const type = raw.type;
  if (!isMediaSessionCommandType(type)) return null;

  if (type === 'seekAbsolute') {
    const positionSeconds = Number(raw.positionSeconds);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
    return { type, positionSeconds: Math.min(MAX_DURATION_SECONDS, positionSeconds) };
  }

  if (type === 'seekRelative') {
    const offsetSeconds = Number(raw.offsetSeconds);
    if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) return null;
    const bounded = Math.max(-MAX_DURATION_SECONDS, Math.min(MAX_DURATION_SECONDS, offsetSeconds));
    return { type, offsetSeconds: bounded };
  }

  if (type === 'setRate') {
    const rate = Number(raw.rate);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return { type, rate: normalizeRate(rate) };
  }

  return { type };
}

/** Whether the snapshot says this command is available right now. */
export function supportsMediaSessionCommand(
  snapshot: MediaSessionSnapshot,
  type: MediaSessionCommandType,
): boolean {
  return snapshot.supportedCommands.includes(type);
}

/**
 * Resolve a seek command to an absolute position inside the current item.
 *
 * A relative skip carries the interval the platform chose. macOS publishes
 * LoomTV's own skip intervals as preferred intervals and echoes back the one it
 * used, so the offset already reflects the user's setting.
 */
export function resolveSeekPosition(
  snapshot: MediaSessionSnapshot,
  command: MediaSessionCommand,
): number | null {
  if (command.type === 'seekAbsolute') {
    if (snapshot.durationSeconds <= 0) return null;
    return Math.min(snapshot.durationSeconds, Math.max(0, command.positionSeconds));
  }
  if (command.type === 'seekRelative') {
    if (snapshot.durationSeconds <= 0) return null;
    const target = snapshot.positionSeconds + command.offsetSeconds;
    return Math.min(snapshot.durationSeconds, Math.max(0, target));
  }
  return null;
}

/**
 * Whether this snapshot is a discontinuity worth publishing.
 *
 * Position advances on every playback tick. All three platform APIs interpolate
 * it from elapsed time and rate, and MPRIS explicitly excludes `Position` from
 * change notifications, so only real transitions are published: a state change,
 * a new item, a rate change, a capability change, or a position that moved
 * somewhere playback alone could not have taken it.
 */
export function isMediaSessionDiscontinuity(
  previous: MediaSessionSnapshot | null,
  next: MediaSessionSnapshot,
  toleranceSeconds = 2,
): boolean {
  if (!previous) return true;
  if (previous.sessionId !== next.sessionId) return true;
  if (previous.state !== next.state) return true;
  if (previous.rate !== next.rate) return true;
  if (previous.durationSeconds !== next.durationSeconds) return true;
  if (previous.title !== next.title) return true;
  if (previous.seriesTitle !== next.seriesTitle) return true;
  if (previous.season !== next.season || previous.episode !== next.episode) return true;
  if (previous.artworkUrl !== next.artworkUrl) return true;
  if (previous.queueIndex !== next.queueIndex || previous.queueCount !== next.queueCount) return true;
  if (previous.skipForwardSeconds !== next.skipForwardSeconds) return true;
  if (previous.skipBackSeconds !== next.skipBackSeconds) return true;
  if (previous.supportedCommands.join('|') !== next.supportedCommands.join('|')) return true;

  // A paused session never moves on its own, so any position change is a seek.
  if (next.state !== 'playing') return previous.positionSeconds !== next.positionSeconds;
  return Math.abs(next.positionSeconds - previous.positionSeconds) > toleranceSeconds;
}
