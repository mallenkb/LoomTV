import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createDesktopBridge } from '../../../desktop/src/shared/createDesktopBridge';
import { createTauriTransport } from './transport';

export function createTauriBridge() {
  const rendererId = crypto.randomUUID();
  let closed = false;
  // A fresh document must reclaim playback before it can issue new commands.
  const ready = invoke('desktop_invoke', { channel: 'renderer:attach', args: [rendererId] });
  void ready.catch(() => undefined);
  const { transport, dispose } = createTauriTransport({
    async invoke<T>(command: string, args: { channel: string; args: unknown[] }): Promise<T> {
      await ready;
      if (closed) throw Object.assign(new Error('The desktop connection has closed.'), { code: 'bridge_closed' });
      return invoke<T>(command, { ...args, rendererId });
    },
    listen,
  });
  window.addEventListener('pagehide', () => {
    closed = true;
    dispose();
    void ready.then(() => invoke('desktop_invoke', {
      channel: 'renderer:detach', args: [rendererId],
    })).catch(() => undefined);
  }, { once: true });
  return createDesktopBridge(transport);
}
