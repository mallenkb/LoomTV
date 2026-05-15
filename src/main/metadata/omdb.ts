import { numericRating } from './helpers';
import type { MediaItem } from './types';

export async function fetchOMDbMetadata(title: string, year?: number, omdbApiKey?: string): Promise<Record<string, any> | null> {
  if (!omdbApiKey) return null;
  try {
    const attempts = year ? [year, undefined] : [undefined];
    for (const attemptYear of attempts) {
      const yearParam = attemptYear ? `&y=${attemptYear}` : '';
      const url = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
      const res = await fetch(url);
      const data = await res.json() as Record<string, any>;
      if (data.Response !== 'False') return data;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchOMDbMetadataById(imdbId: string | undefined, omdbApiKey?: string): Promise<Record<string, any> | null> {
  if (!imdbId || !omdbApiKey) return null;
  try {
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbApiKey)}`;
    const res = await fetch(url);
    const data = await res.json() as Record<string, any>;
    return data.Response !== 'False' ? data : null;
  } catch {
    return null;
  }
}

export async function fetchOMDbMovieMetadata(title: string, year?: number, omdbApiKey?: string): Promise<Partial<MediaItem> | null> {
  if (!omdbApiKey) return null;
  try {
    const yearParam = year ? `&y=${year}` : '';
    const url = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
    const res = await fetch(url);
    const data: any = await res.json();
    if (data.Response === 'False') return null;

    return {
      poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
      backdrop: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
      summary: data.Plot || '',
      rating: numericRating(data.imdbRating),
      genres: data.Genre ? data.Genre.split(', ') : [],
      cast: [],
      year: data.Year ? parseInt(data.Year, 10) : year || 0,
    };
  } catch (error) {
    console.error('OMDb fetch error:', error);
    return null;
  }
}
