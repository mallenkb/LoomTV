import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createDesktopBridge, type DesktopTransport } from '../../../desktop/src/shared/createDesktopBridge';

type Listener = Parameters<DesktopTransport['on']>[1];

export function createTauriBridge() {
  const subscriptions = new Map<string, Map<Listener, () => void>>();
  const transport: DesktopTransport = {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      try {
        return await invoke<T>('desktop_invoke', { channel, args });
      } catch (cause) {
        const payload = typeof cause === 'object' && cause !== null ? cause : { message: String(cause) };
        const message = 'message' in payload ? String(payload.message) : 'The desktop operation failed.';
        throw Object.assign(new Error(message), payload);
      }
    },
    on(channel, listener) {
      const listeners = subscriptions.get(channel) ?? new Map();
      subscriptions.set(channel, listeners);
      listeners.get(listener)?.();
      let cancelled = false;
      let stop: UnlistenFn | undefined;
      listeners.set(listener, () => { cancelled = true; stop?.(); });
      void listen<unknown[]>(`loomtv:${channel}`, event => {
        if (!cancelled) listener(undefined, ...event.payload);
      }).then(unlisten => {
        if (cancelled) unlisten();
        else stop = unlisten;
      }).catch(error => {
        if (!cancelled) console.error('Desktop event subscription failed', channel, error);
      });
    },
    removeListener(channel, listener) {
      const listeners = subscriptions.get(channel);
      listeners?.get(listener)?.();
      listeners?.delete(listener);
      if (listeners?.size === 0) subscriptions.delete(channel);
    },
  };
  window.addEventListener('pagehide', () => {
    for (const listeners of subscriptions.values()) for (const stop of listeners.values()) stop();
    subscriptions.clear();
  }, { once: true });
  return createDesktopBridge(transport);
}
