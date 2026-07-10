export type UpdateAdapterStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error';

export interface UpdateAdapterState {
  status: UpdateAdapterStatus;
  supported: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

interface UpdateAdapterDeps<TState extends UpdateAdapterState> {
  getState: () => TState;
  configure: () => void;
  checkForUpdates: () => Promise<TState>;
  promptForDownloadedUpdate: () => void;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  setInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

export interface UpdateAdapter {
  start: () => void;
  stop: () => void;
  checkNow: () => Promise<UpdateAdapterState>;
}

const DEFAULT_STARTUP_DELAY_MS = 5000;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BUSY_UPDATE_STATUSES = new Set<UpdateAdapterStatus>([
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
]);

export function createUpdateAdapter<TState extends UpdateAdapterState>(
  deps: UpdateAdapterDeps<TState>,
): UpdateAdapter {
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;
  const scheduleInterval = deps.setInterval ?? setInterval;
  const cancelInterval = deps.clearInterval ?? clearInterval;
  let startupTimer: TimerHandle | null = null;
  let intervalTimer: IntervalHandle | null = null;

  const shouldCheck = () => {
    const state = deps.getState();
    return state.supported && !BUSY_UPDATE_STATUSES.has(state.status);
  };

  const checkNow = async () => {
    if (!shouldCheck()) return deps.getState();

    const nextState = await deps.checkForUpdates();
    if (nextState.status === 'downloaded') {
      deps.promptForDownloadedUpdate();
    }
    return nextState;
  };

  return {
    start() {
      deps.configure();
      if (startupTimer || intervalTimer) return;

      startupTimer = scheduleTimeout(() => {
        startupTimer = null;
        void checkNow();
      }, startupDelayMs);

      intervalTimer = scheduleInterval(() => {
        void checkNow();
      }, checkIntervalMs);
    },

    stop() {
      if (startupTimer) {
        cancelTimeout(startupTimer);
        startupTimer = null;
      }
      if (intervalTimer) {
        cancelInterval(intervalTimer);
        intervalTimer = null;
      }
    },

    checkNow,
  };
}
