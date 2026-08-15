import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// The phone/tablet shell is a browser-only layout. The Electron window keeps
// its desktop geometry at every size, so mark which client is rendering and let
// the stylesheet scope the responsive shell to the web app alone.
document.documentElement.dataset.loomClient = window.desktopApi ? 'desktop' : 'browser';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}