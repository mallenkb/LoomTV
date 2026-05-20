import { useEffect, useRef, useState } from 'react';

type FallbackThumbnailDecision = {
  hasArtworkSources: boolean;
  hasArtworkFailed?: boolean;
  isVisible: boolean;
};

type EpisodeFileLike = {
  season: number;
  episode: number;
  filePath?: string;
};

export function shouldRequestFallbackThumbnail({
  hasArtworkFailed = false,
  hasArtworkSources,
  isVisible,
}: FallbackThumbnailDecision): boolean {
  return isVisible && (!hasArtworkSources || hasArtworkFailed);
}

export function firstEpisodeFilePath(files: EpisodeFileLike[] | undefined): string | undefined {
  return files
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .find((file) => Boolean(file.filePath))
    ?.filePath;
}

export function useDeferredVisibility<T extends Element>(rootMargin = '600px') {
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isVisible) return undefined;

    const element = ref.current;
    if (!element) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setIsVisible(true);
      observer.disconnect();
    }, { rootMargin });

    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible, rootMargin]);

  return [ref, isVisible] as const;
}
