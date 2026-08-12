type RatingProvider = 'imdb' | 'tomatometer' | 'popcornmeter' | 'metacritic';

const LOGOS: Record<RatingProvider, string> = {
  imdb: new URL('../assets/ratings/imdb.svg', import.meta.url).href,
  tomatometer: new URL('../assets/ratings/tomatometer.svg', import.meta.url).href,
  popcornmeter: new URL('../assets/ratings/popcornmeter.svg', import.meta.url).href,
  metacritic: new URL('../assets/ratings/metacritic.svg', import.meta.url).href,
};

export default function ProviderRatingLogo({
  provider,
  className = 'h-5 w-5',
}: {
  provider: RatingProvider;
  className?: string;
}) {
  return (
    <img
      aria-hidden="true"
      alt=""
      src={LOGOS[provider]}
      className={className}
    />
  );
}
