import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider } from '@/components/ConfirmProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import LiveTvSettingsSection from '@/pages/LiveTvSettingsSection';
import '@/index.css';

declare global {
  interface Window {
    __settingsModalApiCalls: string[];
    __setSettingsModalWidth: (width: number) => void;
    __setSettingsModalTheme: (theme: 'dark' | 'light', homeStyle: 'default' | 'modern') => void;
  }
}

const apiCalls: string[] = [];
const safeDesktopApi = new Proxy({}, {
  get(_target, property) {
    return async () => {
      const method = String(property);
      apiCalls.push(method);
      if (method === 'listStremioPlugins') return { ok: true, data: [] };
      if (method === 'listIptvSources') return [];
      throw new Error(`Unexpected desktop API call in settings modal fixture: ${method}`);
    };
  },
});

Object.defineProperty(window, 'desktopApi', { configurable: true, value: safeDesktopApi });
window.__settingsModalApiCalls = apiCalls;

function ModalControlSamples() {
  return (
    <div className="mt-3 flex items-center gap-2" data-testid="modal-control-samples">
      <select aria-label="Modal dropdown sample" defaultValue="one">
        <option value="one">One</option>
        <option value="two">Two</option>
      </select>
      <span data-ui-chip className="px-2 py-1 text-xs">Ready</span>
    </div>
  );
}

function Fixture() {
  const [nativeOpen, setNativeOpen] = useState(false);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    document.documentElement.style.setProperty('--fixture-modal-width', `${width}px`);
  }, [width]);

  window.__setSettingsModalWidth = (nextWidth) => {
    document.documentElement.style.setProperty('--fixture-modal-width', `${nextWidth}px`);
    setWidth(nextWidth);
  };
  window.__setSettingsModalTheme = (theme, homeStyle) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.homeStyle = homeStyle;
  };

  return (
    <div id="fixture-wrapper">
      <button id="open-native-modal" type="button" onClick={() => setNativeOpen(true)}>Open Live TV modal</button>
      <button id="background-focus-target" type="button">Background focus target</button>

      <Dialog open={nativeOpen} onOpenChange={setNativeOpen} contentClassName="fixture-native-dialog">
        <DialogContent>
          <DialogHeader className="mb-3 text-left">
            <DialogTitle>Live TV source</DialogTitle>
            <DialogDescription>Add a playlist to the sidebar.</DialogDescription>
          </DialogHeader>
          <LiveTvSettingsSection addOnly />
          <ModalControlSamples />
        </DialogContent>
      </Dialog>

    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  #root { min-height: 100vh; }
  .fixture-native-dialog {
    width: min(var(--fixture-modal-width, 560px), calc(100vw - 32px)) !important;
    max-width: none !important;
  }
`;
document.head.append(style);

const root = document.getElementById('root');
if (!root) throw new Error('Settings modal fixture needs a #root element.');

createRoot(root).render(
  <ConfirmProvider>
    <Fixture />
  </ConfirmProvider>,
);
