import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CONTROLS_HIDE_MS } from './constants';

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function usePlayerChrome(paused: boolean, containerRef: RefObject<HTMLDivElement | null>) {
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  const [showControls, setShowControls] = useState(true);
  const [showTopControls, setShowTopControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    setShowTopControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!pausedRef.current) {
        setShowControls(false);
        setShowTopControls(false);
      }
    }, CONTROLS_HIDE_MS);
  }, []);

  const handlePointerMove = useCallback(() => resetHideTimer(), [resetHideTimer]);

  useEffect(() => {
    if (paused) {
      setShowControls(true);
      setShowTopControls(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    resetHideTimer();
  }, [paused, resetHideTimer]);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    const doc = document as WebkitDocument;
    const onFullscreenChange = () => setFullscreen(Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current as WebkitFullscreenElement | null;
    if (!element) return;
    const doc = document as WebkitDocument;
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (!fullscreenElement) {
      const requestFullscreen = element.requestFullscreen?.bind(element)
        ?? element.webkitRequestFullscreen?.bind(element);
      if (requestFullscreen) void requestFullscreen();
      return;
    }
    const exitFullscreen = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
    if (exitFullscreen) void exitFullscreen();
  }, [containerRef]);

  return {
    fullscreen,
    handlePointerMove,
    resetHideTimer,
    showControls,
    showTopControls,
    toggleFullscreen,
  };
}
