import { useEffect, useRef, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { desktopApi } from '@/lib/desktopApi';
import type { OriginPlatform, StreamingProvider } from '@/shared/desktopProtocol';
import { preferredProviderLogoUrl } from '@/shared/providerLogos';

const providerCache = new Map<string, StreamingProvider[]>();
const providerRequests = new Map<string, Promise<StreamingProvider[]>>();

type ProviderMarkProps = {
  mediaId: string;
  providers?: readonly StreamingProvider[];
  originPlatform?: OriginPlatform;
  className?: string;
};

function loadProviders(mediaId: string): Promise<StreamingProvider[]> {
  const cached = providerCache.get(mediaId);
  if (cached) return Promise.resolve(cached);

  const pending = providerRequests.get(mediaId);
  if (pending) return pending;

  const request = desktopApi.getStreamingProviders(mediaId)
    .then((providers) => {
      const next = Array.isArray(providers) ? providers : [];
      providerCache.set(mediaId, next);
      return next;
    })
    .catch(() => {
      providerCache.set(mediaId, []);
      return [];
    })
    .finally(() => {
      providerRequests.delete(mediaId);
    });

  providerRequests.set(mediaId, request);
  return request;
}

function primaryProvider(providers: readonly StreamingProvider[] | undefined): StreamingProvider | undefined {
  if (!providers?.length) return undefined;
  const firstAvailability = providers[0]?.availability;
  return providers.find((candidate) => (
    candidate.availability === firstAvailability
    && Boolean(preferredProviderLogoUrl(candidate))
  )) || providers[0];
}

export default function ProviderMark({ mediaId, providers, originPlatform, className = 'h-8 w-8' }: ProviderMarkProps) {
  const [resolvedProviders, setResolvedProviders] = useState<readonly StreamingProvider[] | undefined>(providers);
  const [logoFailed, setLogoFailed] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const markRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setLogoFailed(false);
    if (providers && providers.length > 0) {
      setResolvedProviders(providers);
      return undefined;
    }

    let cancelled = false;
    const cached = providerCache.get(mediaId);
    if (cached) {
      setResolvedProviders(cached);
      return undefined;
    }

    setResolvedProviders(undefined);
    void loadProviders(mediaId).then((next) => {
      if (!cancelled) setResolvedProviders(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mediaId, originPlatform?.logoUrl, originPlatform?.name, providers]);

  const provider = primaryProvider(resolvedProviders);
  const preferredLogoUrl = provider
    ? preferredProviderLogoUrl(provider)
    : originPlatform?.logoUrl || preferredProviderLogoUrl({ name: originPlatform?.name });
  const hasLogo = Boolean(preferredLogoUrl && !logoFailed);
  const providerLogoUrl = hasLogo ? preferredLogoUrl : undefined;
  const providerName = provider?.name || originPlatform?.name || 'Streaming provider unavailable';
  const providerLabel = provider?.availability === 'other-region'
    ? `${providerName} · Available in other regions`
    : provider
      ? providerName
      : originPlatform
        ? `Originally on ${providerName}`
        : providerName;

  useEffect(() => {
    if (!tooltipOpen) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!markRef.current?.contains(event.target as Node)) setTooltipOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTooltipOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [tooltipOpen]);

  return (
    <span ref={markRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        className={`grid ${className} shrink-0 place-items-center text-white shadow-lg outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-white/80 ${hasLogo ? 'overflow-hidden rounded-xl border border-white/30 bg-black/70' : 'rounded-full border border-white/80 bg-black/45'}`}
        aria-label={provider || originPlatform ? providerLabel : 'Streaming provider unavailable'}
        aria-expanded={tooltipOpen}
        onClick={() => setTooltipOpen((open) => !open)}
      >
        {providerLogoUrl ? (
          <img
            src={providerLogoUrl}
            alt=""
            className="h-full w-full object-contain"
            loading="eager"
            referrerPolicy="no-referrer"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <Clapperboard className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      {tooltipOpen && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--loom-surface-3)] px-2.5 py-1 text-xs font-medium text-[var(--loom-text)] shadow-lg ring-1 ring-white/10"
        >
          {providerLabel}
        </span>
      )}
    </span>
  );
}
