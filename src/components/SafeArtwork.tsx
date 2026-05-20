import React, { useEffect, useState } from 'react';

interface SafeArtworkProps {
  src: string | string[];
  alt: string;
  className: string;
  imgClassName?: string;
  loading?: 'eager' | 'lazy';
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
  loading = 'lazy',
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

  const backgroundStyle = currentSource
    ? { backgroundImage: `url("${currentSource.replace(/"/g, '\\"')}")`, backgroundPosition: 'center', backgroundSize: 'cover' }
    : undefined;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br from-[var(--loom-surface)] via-[#1f2933] to-[var(--loom-bg)] ${className}`}
      style={backgroundStyle}
    >
      {!currentSource && fallback}
      {currentSource && (
        <img
          src={currentSource}
          alt={alt}
          loading={loading}
          decoding="async"
          className={`absolute inset-0 z-10 h-full w-full ${imgClassName}`}
          onError={() => {
            onError?.();
            setSourceIndex((index) => Math.min(index + 1, sources.length));
          }}
        />
      )}
    </div>
  );
}
