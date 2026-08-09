import type { ContentRating } from './types.ts';

const MINIMUM_AGES: Record<string, Record<string, number>> = {
  US: {
    G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': 18,
    'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
  },
  GB: { U: 0, PG: 8, '12': 12, '12A': 12, '15': 15, '18': 18, R18: 18 },
  CA: { G: 0, PG: 8, '14A': 14, '18A': 18, R: 18, A: 18 },
  AU: { G: 0, PG: 8, M: 15, 'MA15+': 15, 'R18+': 18, 'X18+': 18 },
  BR: { L: 0, '10': 10, '12': 12, '14': 14, '16': 16, '18': 18 },
  DE: { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 },
  ES: { TP: 0, '7': 7, '12': 12, '16': 16, '18': 18 },
  FR: { U: 0, '-10': 10, '12': 12, '16': 16, '18': 18 },
  IN: { U: 0, 'U/A': 13, UA: 13, A: 18, S: 18 },
  IT: { T: 0, VM6: 6, VM8: 8, VM12: 12, VM14: 14, VM18: 18 },
  JP: { G: 0, PG12: 12, 'R15+': 15, 'R18+': 18 },
  KR: { ALL: 0, '12': 12, '15': 15, '18': 18 },
  MX: { AA: 0, A: 0, B: 12, B15: 15, C: 18, D: 18 },
  NL: { AL: 0, '6': 6, '9': 9, '12': 12, '14': 14, '16': 16, '18': 18 },
  NZ: { G: 0, PG: 8, M: 16, R13: 13, R15: 15, R16: 16, R18: 18, RP13: 13, RP16: 16 },
};

const EMPTY_RATING_CODES = new Set(['N/A', 'NA', 'NONE', 'NOT RATED', 'UNKNOWN', 'UNRATED']);

function inferredMinimumAge(code: string): number {
  const explicitAge = code.match(/(?:^|[^0-9])(\d{1,2})(?:\s*\+)?(?:$|[^0-9])/);
  if (explicitAge) return Number(explicitAge[1]);
  if (/^(?:G|U|ALL|AL|L|TP|T)$/.test(code)) return 0;
  if (/^(?:A|C|D|R18|R18\+|X18\+|NC-17|TV-MA)$/.test(code)) return 18;
  return 0;
}

export function normalizeContentRating(
  country: string,
  rawCode: string | null | undefined,
  source: ContentRating['source'],
): ContentRating | null {
  const normalizedCountry = country.trim().toUpperCase();
  const code = (rawCode || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalizedCountry || !code || EMPTY_RATING_CODES.has(code)) return null;

  const minimumAge = MINIMUM_AGES[normalizedCountry]?.[code] ?? inferredMinimumAge(code);
  return { code, minimumAge, source };
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
