import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// The phone/tablet shell is a browser-only layout. The Electron window keeps
// its desktop geometry at every size, so mark which client is rendering and let
// the stylesheet scope the responsive shell to the web app alone.
document.documentElement.dataset.loomClient = window.desktopApi ? 'desktop' : 'browser';

// Heroes take their height from the display, not the window, so a title page
// looks the same windowed and in full screen. The desktop app sets this from
// the primary display in the main process; a browser only knows its own screen.
if (!window.desktopApi) {
  const syncScreenHeight = () => {
    document.documentElement.style.setProperty('--loom-screen-height', `${window.screen.height}px`);
  };
  syncScreenHeight();
  window.addEventListener('resize', syncScreenHeight);
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}