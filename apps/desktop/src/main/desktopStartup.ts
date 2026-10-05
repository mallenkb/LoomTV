import type { UnifiedDesktopServerState } from '../shared/desktopProtocol.ts';

export async function startDesktopPresentation(options: {
  waitForSetup: boolean;
  presentWindow: () => void;
  startServer: () => Promise<UnifiedDesktopServerState>;
  serverSettled: (state: UnifiedDesktopServerState) => void;
}): Promise<void> {
  if (!options.waitForSetup) {
    options.presentWindow();
    // Let Electron create the native window before canonical startup does work.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const state = await options.startServer();
  options.serverSettled(state);
  if (options.waitForSetup) options.presentWindow();
}
