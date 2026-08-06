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
  const fullscreenRef = useRef<boolean | null>(null);
  const fullscreenReadyRafRef = useRef<number | null>(null);
  const fullscreenReadyResolverRef = useRef<((ready: boolean) => void) | null>(null);
  const nativeFullscreenTransitionRef = useRef(false);
  const fullscreenToggleInFlightRef = useRef(false);
  const fullscreenToggleFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const releaseFullscreenToggle = useCallback(() => {
    fullscreenToggleInFlightRef.current = false;
    if (fullscreenToggleFallbackTimerRef.current) {
      clearTimeout(fullscreenToggleFallbackTimerRef.current);
      fullscreenToggleFallbackTimerRef.current = null;
    }
  }, []);

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
    releaseFullscreenToggle();
    if (nativeFullscreenTransitionRef.current) {
      nativeFullscreenTransitionRef.current = false;
      void desktopApi.libvlc.setFullscreenTransition(false, false);
    }
  }, [releaseFullscreenToggle]);

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
      // Chromium can emit both standard and prefixed events for one change.
      // Process the state transition once so duplicate events cannot cancel
      // and restart the native-surface readiness handshake.
      if (fullscreenRef.current === nextFullscreen) return;
      fullscreenRef.current = nextFullscreen;
      setFullscreen(nextFullscreen);
      resetHideTimer();
      // Keep the player on its original HTML fullscreen lifecycle. LibVLC is
      // only an embedded video surface; it must follow the renderer rather
      // than replacing fullscreen with simple pre-Lion window takeover.
      if (nativeSurfaceActive) {
        void waitForNativeSurfaceReady().finally(releaseFullscreenToggle);
      } else {
        releaseFullscreenToggle();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, [nativeSurfaceActive, releaseFullscreenToggle, resetHideTimer, waitForNativeSurfaceReady]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreenToggleInFlightRef.current) return;
    const element = containerRef.current as WebkitFullscreenElement | null;
    if (!element) return;
    const doc = document as WebkitDocument;
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const changeFullscreen = !fullscreenElement
      ? element.requestFullscreen?.bind(element) ?? element.webkitRequestFullscreen?.bind(element)
      : doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
    if (!changeFullscreen) return;

    fullscreenToggleInFlightRef.current = true;
    resetHideTimer();
    fullscreenToggleFallbackTimerRef.current = setTimeout(() => {
      releaseFullscreenToggle();
      if (!nativeFullscreenTransitionRef.current) return;
      nativeFullscreenTransitionRef.current = false;
      void desktopApi.libvlc.setFullscreenTransition(false, false);
    }, 8_000);
    void (async () => {
      try {
        if (nativeSurfaceActive) {
          // Commit the exact starting rectangle before AppKit takes over the
          // animated resize. This prevents a stale pre-transition viewport
          // from producing a visible first-frame jump.
          await (syncNativeViewport?.() ?? Promise.resolve(true));
          // AppKit must enable proportional autoresizing before Chromium starts
          // changing the fullscreen window. Starting both operations at once
          // lets the first fullscreen frames use the old native-video bounds,
          // which reads as a hitch even when the final viewport is correct.
          nativeFullscreenTransitionRef.current = true;
          const prepared = await desktopApi.libvlc.setFullscreenTransition(true, false);
          if (!prepared) nativeFullscreenTransitionRef.current = false;
        }
        await Promise.resolve(changeFullscreen());
      } catch {
        if (nativeFullscreenTransitionRef.current) {
          nativeFullscreenTransitionRef.current = false;
          await desktopApi.libvlc.setFullscreenTransition(false, false).catch(() => false);
        }
        releaseFullscreenToggle();
      } finally {
        // Native playback keeps the guard until the post-fullscreen viewport
        // and drawable handshake completes. Browser playback has no second
        // compositor to synchronize, so its gesture can finish immediately.
        if (!nativeSurfaceActive) releaseFullscreenToggle();
      }
    })();
  }, [containerRef, nativeSurfaceActive, releaseFullscreenToggle, resetHideTimer, syncNativeViewport]);

  return {
    fullscreen,
    handlePointerMove,
    resetHideTimer,
    showControls,
    showTopControls,
    toggleFullscreen,
  };
}
