import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import { CONTROLS_HIDE_MS } from './constants';

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function usePlayerChrome(
  paused: boolean,
  containerRef: RefObject<HTMLDivElement | null>,
  nativeSurfaceActive = false,
  syncNativeViewport?: () => Promise<boolean>,
) {
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  const [showControls, setShowControls] = useState(true);
  const [showTopControls, setShowTopControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenReadyRafRef = useRef<number | null>(null);
  const fullscreenReadyResolverRef = useRef<((ready: boolean) => void) | null>(null);
  const nativeFullscreenTransitionRef = useRef(false);

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
    if (fullscreenReadyRafRef.current !== null) cancelAnimationFrame(fullscreenReadyRafRef.current);
    fullscreenReadyResolverRef.current?.(false);
    fullscreenReadyResolverRef.current = null;
    if (nativeFullscreenTransitionRef.current) {
      nativeFullscreenTransitionRef.current = false;
      void desktopApi.libvlc.setFullscreenTransition(false, false);
    }
  }, []);

  const waitForNativeSurfaceReady = useCallback(() => new Promise<boolean>((resolve) => {
    fullscreenReadyResolverRef.current?.(false);
    fullscreenReadyResolverRef.current = resolve;
    if (fullscreenReadyRafRef.current !== null) cancelAnimationFrame(fullscreenReadyRafRef.current);
    let attempts = 0;
    const finish = (ready: boolean) => {
      if (fullscreenReadyResolverRef.current === resolve) {
        fullscreenReadyResolverRef.current = null;
        fullscreenReadyRafRef.current = null;
      }
      resolve(ready);
    };
    const check = () => {
      fullscreenReadyRafRef.current = null;
      if (!nativeSurfaceActive) {
        finish(true);
        return;
      }
      const commitViewport = syncNativeViewport?.() ?? Promise.resolve(true);
      void commitViewport.then(async (viewportCommitted) => {
        let transitionCommitted = false;
        if (nativeFullscreenTransitionRef.current) {
          nativeFullscreenTransitionRef.current = false;
          transitionCommitted = await desktopApi.libvlc.setFullscreenTransition(false, true);
          if (!transitionCommitted) return false;
        }
        if (!viewportCommitted) return false;
        // Ending the guarded transition already applies the final viewport and
        // rebinds the drawable. A second immediate rebind can restart the macOS
        // vout transaction and introduce the very flash this handshake avoids.
        if (transitionCommitted) return true;
        return desktopApi.libvlc.syncSurface();
      }).then((ready) => {
        if (ready) {
          finish(true);
          return;
        }
        attempts += 1;
        if (attempts >= 24) {
          finish(false);
          return;
        }
        fullscreenReadyRafRef.current = requestAnimationFrame(check);
      }).catch(() => finish(false));
    };
    // Let the confirmed fullscreen state commit and the viewport ResizeObserver
    // report its final geometry before asking the native host to rebind.
    fullscreenReadyRafRef.current = requestAnimationFrame(() => {
      fullscreenReadyRafRef.current = requestAnimationFrame(check);
    });
  }), [nativeSurfaceActive, syncNativeViewport]);

  useEffect(() => {
    const doc = document as WebkitDocument;
    const onFullscreenChange = () => {
      const nextFullscreen = Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
      setFullscreen(nextFullscreen);
      resetHideTimer();
      // Keep the player on its original HTML fullscreen lifecycle. LibVLC is
      // only an embedded video surface; it must follow the renderer rather
      // than replacing fullscreen with simple pre-Lion window takeover.
      if (nativeSurfaceActive) void waitForNativeSurfaceReady();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, [nativeSurfaceActive, resetHideTimer, waitForNativeSurfaceReady]);

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current as WebkitFullscreenElement | null;
    if (!element) return;
    const doc = document as WebkitDocument;
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (!fullscreenElement) {
      const requestFullscreen = element.requestFullscreen?.bind(element)
        ?? element.webkitRequestFullscreen?.bind(element);
      if (requestFullscreen) {
        if (nativeSurfaceActive) {
          nativeFullscreenTransitionRef.current = true;
          void desktopApi.libvlc.setFullscreenTransition(true, false).then((started) => {
            if (!started) nativeFullscreenTransitionRef.current = false;
          }).catch(() => {
            nativeFullscreenTransitionRef.current = false;
          });
        }
        void Promise.resolve(requestFullscreen()).catch(() => {
          if (!nativeFullscreenTransitionRef.current) return;
          nativeFullscreenTransitionRef.current = false;
          void desktopApi.libvlc.setFullscreenTransition(false, false);
        });
      }
      return;
    }
    const exitFullscreen = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
    if (exitFullscreen) {
      if (nativeSurfaceActive) {
        nativeFullscreenTransitionRef.current = true;
        void desktopApi.libvlc.setFullscreenTransition(true, false).then((started) => {
          if (!started) nativeFullscreenTransitionRef.current = false;
        }).catch(() => {
          nativeFullscreenTransitionRef.current = false;
        });
      }
      void Promise.resolve(exitFullscreen()).catch(() => {
        if (!nativeFullscreenTransitionRef.current) return;
        nativeFullscreenTransitionRef.current = false;
        void desktopApi.libvlc.setFullscreenTransition(false, false);
      });
    }
  }, [containerRef, nativeSurfaceActive]);

  return {
    fullscreen,
    handlePointerMove,
    resetHideTimer,
    showControls,
    showTopControls,
    toggleFullscreen,
  };
}
