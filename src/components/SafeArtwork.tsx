import React, { useEffect, useState } from 'react';

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
  const sources = normalizeSources(src);
  const sourceKey = sources.join('|');
  const currentSource = sources[sourceIndex] || '';

  useEffect(() => {
    setSourceIndex(0);
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
            setSourceIndex((index) => Math.min(index + 1, sources.length));
          }}
        />
      )}
    </div>
  );
}
