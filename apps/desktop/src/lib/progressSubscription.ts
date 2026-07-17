export type ProgressRefreshEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

type ProgressRefreshSubscriptionOptions = {
  eventTarget: ProgressRefreshEventTarget;
  onRefresh: () => void;
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (timerId: number) => void;
  intervalMs?: number;
  shouldRefreshEvent?: (event: Event) => boolean;
};

export function createProgressRefreshSubscription({
  eventTarget,
  onRefresh,
  setInterval,
  clearInterval,
  intervalMs = 2000,
  shouldRefreshEvent = () => true,
}: ProgressRefreshSubscriptionOptions) {
  const listeners = new Set<() => void>();
  let timerId: number | null = null;

  const publish = () => {
    onRefresh();
    listeners.forEach((listener) => listener());
  };

  const handleEvent = (event: Event) => {
    if (shouldRefreshEvent(event)) publish();
  };

  const attach = () => {
    eventTarget.addEventListener('focus', handleEvent);
    eventTarget.addEventListener('storage', handleEvent);
    eventTarget.addEventListener('loomtv-progress', handleEvent);
    timerId = setInterval(publish, intervalMs);
  };

  const detach = () => {
    eventTarget.removeEventListener('focus', handleEvent);
    eventTarget.removeEventListener('storage', handleEvent);
    eventTarget.removeEventListener('loomtv-progress', handleEvent);
    if (timerId !== null) clearInterval(timerId);
    timerId = null;
  };

  const subscribe = (listener: () => void) => {
    if (listeners.size === 0) attach();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) detach();
    };
  };

  return { publish, subscribe };
}
