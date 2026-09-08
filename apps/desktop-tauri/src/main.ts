import { createTauriBridge } from './bridge/tauriBridge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './desktop.css';
import './webkit.css';

declare const __TAURI_PLATFORM__: string;
document.documentElement.dataset.loomRuntime = 'tauri';
if (__TAURI_PLATFORM__ === 'darwin') {
  document.documentElement.dataset.loomRenderer = 'webkit';
}
document.body.classList.add(`platform-${__TAURI_PLATFORM__}`);

// WebKit does not implement Electron's app-region CSS. Keep the shared drag targets.
document.addEventListener('mousedown', event => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const region = event.target.closest('.loom-main-drag-region, .loom-sidebar-drag-region, .loom-player-drag-region');
  if (!region || event.target.closest('button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]')) return;
  event.preventDefault();
  const action = getCurrentWindow().startDragging();
  void action.catch(error => console.error('Window drag failed', error));
});

// Capability checks in the shared UI run during module evaluation.
window.desktopApi = createTauriBridge();
await import('../../desktop/src/renderer');
