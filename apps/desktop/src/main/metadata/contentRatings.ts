import type { ContentRating } from './types.ts';

type SupportedCountry = 'US' | 'GB' | 'CA' | 'AU';

const MINIMUM_AGES: Record<SupportedCountry, Record<string, number>> = {
  US: {
    G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': 18,
    'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
  },
  GB: { U: 0, PG: 8, '12': 12, '12A': 12, '15': 15, '18': 18, R18: 18 },
  CA: { G: 0, PG: 8, '14A': 14, '18A': 18, R: 18, A: 18 },
  AU: { G: 0, PG: 8, M: 15, 'MA15+': 15, 'R18+': 18, 'X18+': 18 },
};

export function normalizeContentRating(
  country: string,
  rawCode: string | null | undefined,
  source: string,
): ContentRating | null {
  const normalizedCountry = country.trim().toUpperCase() as SupportedCountry;
  const code = (rawCode || '').trim().toUpperCase();
  const minimumAge = MINIMUM_AGES[normalizedCountry]?.[code];
  return minimumAge === undefined ? null : { code, minimumAge, source };
}

export function mergeContentRatings(
  ...collections: Array<Record<string, ContentRating> | null | undefined>
): Record<string, ContentRating> {
  const merged: Record<string, ContentRating> = {};
  for (const collection of collections) {
    for (const [country, rating] of Object.entries(collection || {})) {
      if (!merged[country] || rating.minimumAge > merged[country].minimumAge) merged[country] = rating;
    }
  }
  return merged;
}

export function jikanContentRating(rawRating: string | null | undefined): Record<string, ContentRating> {
  const value = (rawRating || '').toUpperCase();
  const minimumAge = value.startsWith('G ')
    ? 0
    : value.startsWith('PG-13')
      ? 13
      : value.startsWith('PG ')
        ? 8
        : value.startsWith('R+') || value.startsWith('RX')
          ? 18
          : value.startsWith('R ')
            ? 17
            : null;
  if (minimumAge === null) return {};
  return { US: { code: (rawRating || '').split(' - ')[0].trim(), minimumAge, source: 'jikan' } };
}
