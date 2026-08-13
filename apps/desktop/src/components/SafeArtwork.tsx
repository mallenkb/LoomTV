import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Keep several screens of artwork warm so normal rail paging does not expose
// an image-loading gap, while still allowing distant artwork to release its
// decoded image resource when it is no longer near the viewport.
const ARTWORK_PRELOAD_MARGIN = '768px 1200px';
const artworkVisibilityCallbacks = new Map<Element, (visible: boolean) => void>();
let artworkObserver: IntersectionObserver | null = null;

function observeArtwork(element: Element, callback: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callback(true);
    return () => undefined;
  }
  artworkObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) artworkVisibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: ARTWORK_PRELOAD_MARGIN });
  artworkVisibilityCallbacks.set(element, callback);
  artworkObserver.observe(element);
  return () => {
    artworkObserver?.unobserve(element);
    artworkVisibilityCallbacks.delete(element);
    if (artworkVisibilityCallbacks.size === 0) {
      artworkObserver?.disconnect();
      artworkObserver = null;
    }
  };
}

interface SafeArtworkProps {
  src: string | string[];
  alt: string;
  className: string;
  imgClassName?: string;
  fallback?: React.ReactNode;
  placeholderSrc?: string;
  onError?: () => void;
  priority?: boolean;
  naturalSize?: boolean;
}

function normalizeSources(src: string | string[]): string[] {
  const sources = Array.isArray(src) ? src : [src];
  return Array.from(new Set(sources.filter(Boolean)));
}

export default function SafeArtwork({
  src,
  alt,
  className,
  imgClassName = 'object-cover',
  fallback,
  placeholderSrc = '',
  onError,
  priority = false,
  naturalSize = false,
}: SafeArtworkProps) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [loadedSource, setLoadedSource] = useState('');
  const [isNearViewport, setIsNearViewport] = useState(
    () => priority || typeof IntersectionObserver === 'undefined',
  );
  const artworkRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const failedSourcesRef = useRef<Set<string>>(new Set());
  const sources = useMemo(() => normalizeSources(src), [src]);
  const sourceKey = JSON.stringify(sources);
  const currentSource = sources[sourceIndex] || '';
  const sourceLoaded = loadedSource === currentSource;
  const shouldRenderImage = priority || isNearViewport;

  useEffect(() => {
    const artwork = artworkRef.current;
    if (priority || !artwork) {
      if (priority) setIsNearViewport(true);
      return undefined;
    }

    return observeArtwork(artwork, setIsNearViewport);
  }, [priority]);

  useEffect(() => {
    setSourceIndex(0);
    failedSourcesRef.current = new Set();
  }, [sourceKey]);

  useLayoutEffect(() => {
    const image = imageRef.current;
    if (shouldRenderImage && currentSource && image?.complete && image.naturalWidth > 0) {
      setLoadedSource(currentSource);
    }
  }, [currentSource, shouldRenderImage]);

  return (
    <div ref={artworkRef} className={`relative ${naturalSize ? 'overflow-visible bg-transparent' : 'overflow-hidden bg-gradient-to-br from-[var(--loom-surface)] via-[#1f2933] to-[var(--loom-bg)]'} ${className}`}>
      {naturalSize ? <div className="absolute inset-0">{fallback}</div> : fallback}
      {placeholderSrc && !sourceLoaded && (
        <img
          src={placeholderSrc}
          alt=""
          aria-hidden="true"
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          className={`${naturalSize ? 'relative h-auto max-h-full w-auto max-w-full' : 'absolute inset-0 h-full w-full'} ${imgClassName}`}
        />
      )}
      {shouldRenderImage && currentSource && (
        <img
          ref={imageRef}
          src={currentSource}
          alt={alt}
          loading="eager"
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          className={`${naturalSize ? 'relative h-auto max-h-full w-auto max-w-full' : 'absolute inset-0 h-full w-full'} transition-opacity duration-150 ${imgClassName} ${sourceLoaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoadedSource(currentSource)}
          onError={() => {
            onError?.();
            setLoadedSource((loaded) => loaded === currentSource ? '' : loaded);
            const nextFailed = new Set(failedSourcesRef.current).add(currentSource);
            failedSourcesRef.current = nextFailed;
            setSourceIndex((index) => {
              for (let nextIndex = index + 1; nextIndex < sources.length; nextIndex += 1) {
                if (!nextFailed.has(sources[nextIndex])) return nextIndex;
              }
              return sources.length;
            });
          }}
        />
      )}
    </div>
  );
}
