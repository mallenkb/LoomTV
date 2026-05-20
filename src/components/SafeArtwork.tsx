import React, { useEffect, useMemo, useRef, useState } from 'react';

interface SafeArtworkProps {
  src: string | string[];
  alt: string;
  className: string;
  imgClassName?: string;
  fallback?: React.ReactNode;
  onError?: () => void;
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
  onError,
}: SafeArtworkProps) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set());
  const failedSourcesRef = useRef(failedSources);
  const sources = useMemo(() => normalizeSources(src), [src]);
  const sourceKey = sources.join('|');
  const currentSource = sources[sourceIndex] || '';

  useEffect(() => {
    failedSourcesRef.current = failedSources;
  }, [failedSources]);

  useEffect(() => {
    setSourceIndex(0);
    setFailedSources(new Set());
    failedSourcesRef.current = new Set();
  }, [sourceKey]);

  return (
    <div className={`relative overflow-hidden bg-gradient-to-br from-[var(--loom-surface)] via-[#1f2933] to-[var(--loom-bg)] ${className}`}>
      {fallback}
      {currentSource && (
        <img
          src={currentSource}
          alt={alt}
          loading="eager"
          decoding="async"
          className={`absolute inset-0 h-full w-full ${imgClassName}`}
          onError={() => {
            onError?.();
            const nextFailed = new Set(failedSourcesRef.current).add(currentSource);
            failedSourcesRef.current = nextFailed;
            setFailedSources(nextFailed);
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
