export interface OMDbResponse {
  Response?: string;
  Title?: string;
  Year?: string;
  Type?: string;
  Genre?: string;
  Country?: string;
  Language?: string;
  Plot?: string;
  Poster?: string;
  imdbRating?: string;
  [key: string]: string | undefined;
}

export async function fetchOMDbMetadata(title: string, year?: number, omdbApiKey?: string): Promise<OMDbResponse | null> {
  if (!omdbApiKey) return null;
  try {
    const attempts = year ? [year, undefined] : [undefined];
    for (const attemptYear of attempts) {
      const yearParam = attemptYear ? `&y=${attemptYear}` : '';
      const url = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
      const res = await fetch(url);
      const data = (await res.json()) as OMDbResponse;
      if (data.Response !== 'False') return data;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchOMDbMetadataById(imdbId: string | undefined, omdbApiKey?: string): Promise<OMDbResponse | null> {
  if (!imdbId || !omdbApiKey) return null;
  try {
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbApiKey)}`;
    const res = await fetch(url);
    const data = (await res.json()) as OMDbResponse;
    return data.Response !== 'False' ? data : null;
  } catch {
    return null;
  }
}
