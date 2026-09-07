import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createDesktopBridge } from '../../../desktop/src/shared/createDesktopBridge';
import { createTauriTransport } from './transport';

export function createTauriBridge() {
  const { transport, dispose } = createTauriTransport({ invoke, listen });
  window.addEventListener('pagehide', dispose, { once: true });
  return createDesktopBridge(transport);
}
