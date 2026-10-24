import { screen, type BrowserWindow, type Rectangle } from 'electron';

type PlaybackWindowState = {
  sessionId: string;
  ratio: number;
  originalBounds: Rectangle;
  originalMinimum: [number, number];
  fit: () => void;
  dispose: () => void;
};

const playbackWindows = new WeakMap<BrowserWindow, PlaybackWindowState>();
const isFullscreen = (window: BrowserWindow) => window.isFullScreen() || window.isSimpleFullScreen();

function restoreBounds(window: BrowserWindow, bounds: Rectangle): void {
  if (window.isDestroyed() || playbackWindows.has(window)) return;
  if (isFullscreen(window) || window.isMaximized()) {
    const restore = () => {
      window.removeListener('leave-full-screen', restore);
      window.removeListener('leave-html-full-screen', restore);
      window.removeListener('unmaximize', restore);
      restoreBounds(window, bounds);
    };
    window.once('leave-full-screen', restore);
    window.once('leave-html-full-screen', restore);
    window.once('unmaximize', restore);
    return;
  }
  window.setBounds(bounds, false);
}

/** Fit the existing content window to the picture, with no reserved control bands. */
export function setPlaybackWindowAspect(window: BrowserWindow, sessionId: string, ratio: number | null): boolean {
  if (window.isDestroyed()) return false;
  let state = playbackWindows.get(window);
  if (ratio === null) {
    if (!state || state.sessionId !== sessionId) return false;
    state.dispose();
    return true;
  }
  if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) return false;

  if (!state) {
    const originalBounds = window.getNormalBounds();
    const minimum = window.getMinimumSize();
    const originalMinimum: [number, number] = [minimum[0], minimum[1]];
    const contents = window.webContents;
    const fit = () => {
      const current = playbackWindows.get(window);
      if (!current || window.isDestroyed() || isFullscreen(window) || window.isMaximized()) return;
      const bounds = window.getBounds();
      const content = window.getContentBounds();
      const frameWidth = Math.max(0, bounds.width - content.width);
      const frameHeight = Math.max(0, bounds.height - content.height);
      const area = screen.getDisplayMatching(bounds).workArea;
      const maxWidth = Math.max(1, area.width - frameWidth);
      const maxHeight = Math.max(1, area.height - frameHeight);
      // The library minimum must not force letterboxing during playback.
      const minWidth = Math.min(Math.max(360, 240 * current.ratio), maxWidth, maxHeight * current.ratio);
      window.setMinimumSize(Math.round(minWidth + frameWidth), Math.round(minWidth / current.ratio + frameHeight));
      window.setAspectRatio(current.ratio);
      let width = Math.min(Math.max(content.width, minWidth), maxWidth, maxHeight * current.ratio);
      let height = width / current.ratio;
      // Integer content dimensions keep the frame within one pixel of the ratio.
      width = Math.round(width);
      height = Math.round(height);
      const outerWidth = width + frameWidth;
      const outerHeight = height + frameHeight;
      const x = Math.max(area.x, Math.min(area.x + area.width - outerWidth,
        Math.round(bounds.x + (bounds.width - outerWidth) / 2)));
      const y = Math.max(area.y, Math.min(area.y + area.height - outerHeight,
        Math.round(bounds.y + (bounds.height - outerHeight) / 2)));
      if (bounds.x !== x || bounds.y !== y || bounds.width !== outerWidth || bounds.height !== outerHeight) {
        window.setBounds({ x, y, width: outerWidth, height: outerHeight }, false);
      }
    };
    const dispose = () => {
      window.removeListener('leave-full-screen', fit);
      window.removeListener('leave-html-full-screen', fit);
      window.removeListener('unmaximize', fit);
      window.removeListener('closed', dispose);
      contents.removeListener('render-process-gone', dispose);
      playbackWindows.delete(window);
      if (window.isDestroyed()) return;
      window.setAspectRatio(0);
      window.setMinimumSize(...originalMinimum);
      restoreBounds(window, originalBounds);
    };
    const nextState: PlaybackWindowState = { sessionId, ratio, originalBounds, originalMinimum, fit, dispose };
    playbackWindows.set(window, nextState);
    state = nextState;
    window.on('leave-full-screen', fit);
    window.on('leave-html-full-screen', fit);
    window.on('unmaximize', fit);
    window.once('closed', dispose);
    contents.on('render-process-gone', dispose);
  } else {
    state.sessionId = sessionId;
    state.ratio = ratio;
  }
  state.fit();
  return true;
}
