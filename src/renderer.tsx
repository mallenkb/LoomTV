import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const ua = navigator.userAgent;
const platform = /Mac/i.test(ua) ? 'darwin' : /Win/i.test(ua) ? 'win32' : 'linux';
document.body.classList.add(`platform-${platform}`);

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}