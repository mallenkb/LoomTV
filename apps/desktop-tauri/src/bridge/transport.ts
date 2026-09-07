import type { DesktopTransport } from '../../../desktop/src/shared/createDesktopBridge';

type Listener = Parameters<DesktopTransport['on']>[1];
type Stop = () => void;
export interface NativeTransport {
  invoke<T>(command: string, args: { channel: string; args: unknown[] }): Promise<T>;
  listen(name: string, callback: (event: { payload: unknown }) => void): Promise<Stop>;
}
interface Subscription { cancelled: boolean; stop?: Stop }

/** Own asynchronous subscriptions independently of a WebView so teardown is testable. */
export function createTauriTransport(
  native: NativeTransport,
  reportError: (channel: string, error: unknown) => void = (channel, error) => {
    console.error('Desktop event subscription failed', channel, error);
  },
): { transport: DesktopTransport; dispose: Stop } {
  const channels = new Map<string, Map<Listener, Subscription>>();
  let closed = false;
  const closedError = () => Object.assign(new Error('The desktop connection has closed.'), { code: 'bridge_closed' });
  function stop(subscription: Subscription, channel: string) {
    subscription.cancelled = true;
    const unlisten = subscription.stop;
    subscription.stop = undefined;
    try { unlisten?.(); } catch (error) { reportError(channel, error); }
  }
  const transport: DesktopTransport = {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      if (closed) throw closedError();
      try {
        const result = await native.invoke<T>('desktop_invoke', { channel, args });
        if (closed) throw closedError();
        return result;
      } catch (cause) {
        const payload = typeof cause === 'object' && cause !== null ? cause : { message: String(cause) };
        const message = 'message' in payload ? String(payload.message) : 'The desktop operation failed.';
        const error = new Error(message);
        for (const [key, value] of Object.entries(payload)) {
          if (!['__proto__', 'prototype', 'constructor', 'message', 'stack', 'name'].includes(key)) {
            Object.defineProperty(error, key, { value, enumerable: true, configurable: true });
          }
        }
        throw error;
      }
    },
    on(channel, listener) {
      if (closed) throw closedError();
      const listeners = channels.get(channel) ?? new Map<Listener, Subscription>();
      channels.set(channel, listeners);
      const previous = listeners.get(listener);
      if (previous) stop(previous, channel);
      const subscription: Subscription = { cancelled: false };
      listeners.set(listener, subscription);
      void Promise.resolve().then(() => native.listen(`loomtv:${channel}`, event => {
        if (subscription.cancelled || closed) return;
        if (!Array.isArray(event.payload)) {
          reportError(channel, new Error('The desktop event payload must be an argument array.'));
          return;
        }
        listener(undefined, ...event.payload);
      })).then(unlisten => {
        if (subscription.cancelled || closed) unlisten();
        else subscription.stop = unlisten;
      }).catch(error => {
        if (listeners.get(listener) === subscription) {
          listeners.delete(listener);
          if (listeners.size === 0) channels.delete(channel);
        }
        if (!subscription.cancelled && !closed) reportError(channel, error);
      });
    },
    removeListener(channel, listener) {
      const listeners = channels.get(channel);
      const subscription = listeners?.get(listener);
      if (subscription) stop(subscription, channel);
      listeners?.delete(listener);
      if (listeners?.size === 0) channels.delete(channel);
    },
  };
  return {
    transport,
    dispose() {
      if (closed) return;
      closed = true;
      for (const [channel, listeners] of channels) for (const subscription of listeners.values()) stop(subscription, channel);
      channels.clear();
    },
  };
}
