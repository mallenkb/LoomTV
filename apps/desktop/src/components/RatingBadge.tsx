import { Star } from 'lucide-react';
import type { LanProviderRatings } from '@loom-media-server/lan-protocol';
import ProviderRatingLogo from '@/components/ProviderRatingLogo';
import { useTheme } from '@/components/ThemeProvider';

type RatingBadgeProps = {
  rating?: number;
  providerRatings?: LanProviderRatings;
};

export default function RatingBadge({ rating, providerRatings }: RatingBadgeProps) {
  const { showProviderRatingBadges } = useTheme();
  const imdbRating = showProviderRatingBadges ? providerRatings?.imdb?.value : undefined;
  const displayRating = imdbRating ?? rating;

  if (!Number.isFinite(displayRating) || !displayRating || displayRating <= 0) return null;

  return (
    <div
      className="loom-chip absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold backdrop-blur-md"
      title={imdbRating ? 'IMDb rating' : 'Library rating'}
    >
      {imdbRating ? (
        <ProviderRatingLogo provider="imdb" className="h-3.5 w-7 object-contain" />
      ) : (
        <Star className="h-3 w-3" fill="currentColor" />
      )}
      {displayRating.toFixed(1)}
    </div>
  );
}
