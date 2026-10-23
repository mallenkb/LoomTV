import type { LanProviderRatings } from '@loom-media-server/lan-protocol';

/** Shared by local-library metadata and add-on detail enrichment. */
export type OMDbRatingFields = {
  imdbRating?: string;
  imdbVotes?: string;
  Metascore?: string;
  Ratings?: { Source: string; Value: string }[];
};

function ratingBySource(metadata: OMDbRatingFields | null | undefined, source: string): string | undefined {
  return metadata?.Ratings?.find((rating) => rating.Source === source)?.Value;
}

export function scoreFromText(value: string | undefined, scale: 10 | 100): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const score = Number.parseFloat(value);
  return Number.isFinite(score) && score >= 0 && score <= scale ? score : undefined;
}

function voteCountFromText(value: string | undefined): number | undefined {
  if (!value || value === 'N/A') return undefined;
  const votes = Number(value.replaceAll(',', '').trim());
  return Number.isSafeInteger(votes) && votes >= 0 ? votes : undefined;
}

export function omdbProviderRatings(metadata: OMDbRatingFields | null | undefined): LanProviderRatings {
  const imdb = scoreFromText(
    metadata?.imdbRating || ratingBySource(metadata, 'Internet Movie Database'),
    10,
  );
  const rottenTomatoes = scoreFromText(ratingBySource(metadata, 'Rotten Tomatoes'), 100);
  const popcornmeter = scoreFromText(
    ratingBySource(metadata, 'Popcornmeter')
      || ratingBySource(metadata, 'Rotten Tomatoes Audience Score'),
    100,
  );
  const metacritic = scoreFromText(
    metadata?.Metascore || ratingBySource(metadata, 'Metacritic'),
    100,
  );
  const votes = voteCountFromText(metadata?.imdbVotes);

  return {
    ...(imdb === undefined ? {} : {
      imdb: {
        value: imdb,
        scale: 10,
        ...(votes === undefined ? {} : { votes }),
      },
    }),
    ...(rottenTomatoes === undefined ? {} : {
      rottenTomatoes: { value: rottenTomatoes, scale: 100 },
    }),
    ...(popcornmeter === undefined ? {} : {
      popcornmeter: { value: popcornmeter, scale: 100 },
    }),
    ...(metacritic === undefined ? {} : {
      metacritic: { value: metacritic, scale: 100 },
    }),
  };
}
