import { z } from 'zod';

export const tmdbProviderSchema = z.object({
  provider_id: z.number().int(),
  provider_name: z.string(),
  logo_path: z.string().nullish(),
  display_priority: z.number().optional(),
});

const tmdbWatchProviderRegionSchema = z.object({
  flatrate: z.array(tmdbProviderSchema).optional(),
  ads: z.array(tmdbProviderSchema).optional(),
  free: z.array(tmdbProviderSchema).optional(),
});

export const tmdbWatchProviderDetailSchema = z.object({
  results: z.record(z.string(), tmdbWatchProviderRegionSchema).optional(),
});

export const tmdbGenreSchema = z.object({ id: z.number().int(), name: z.string() });
export const tmdbGenreResponseSchema = z.object({ genres: z.array(tmdbGenreSchema).optional() });

const tmdbListResultSchema = z.object({
  id: z.number().int(),
  title: z.string().optional(),
  name: z.string().optional(),
  overview: z.string().optional(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  genre_ids: z.array(z.number().int()).optional(),
  release_date: z.string().optional(),
  first_air_date: z.string().optional(),
  vote_average: z.number().optional(),
  runtime: z.number().optional(),
  number_of_seasons: z.number().optional(),
  number_of_episodes: z.number().optional(),
});

export const tmdbListResponseSchema = z.object({ results: z.array(tmdbListResultSchema).optional() });

const tmdbReleaseDatesSchema = z.object({
  results: z.array(z.object({
    iso_3166_1: z.string().optional(),
    release_dates: z.array(z.object({ certification: z.string().optional() })).optional(),
  })).optional(),
});

const tmdbContentRatingsSchema = z.object({
  results: z.array(z.object({
    iso_3166_1: z.string().optional(),
    rating: z.string().optional(),
  })).optional(),
});

const tmdbVideosSchema = z.object({
  results: z.array(z.object({
    key: z.string().optional(),
    site: z.string().optional(),
    type: z.string().optional(),
    official: z.boolean().optional(),
  })).optional(),
});

export const tmdbReleaseDatesResponseSchema = tmdbReleaseDatesSchema;
export const tmdbContentRatingsResponseSchema = tmdbContentRatingsSchema;
export const tmdbDetailResponseSchema = tmdbListResultSchema.extend({
  credits: z.object({
    cast: z.array(z.object({
      name: z.string().optional(),
      character: z.string().optional(),
      profile_path: z.string().nullish(),
    })).optional(),
  }).optional(),
  genres: z.array(tmdbGenreSchema).optional(),
  release_dates: tmdbReleaseDatesSchema.optional(),
  content_ratings: tmdbContentRatingsSchema.optional(),
  videos: tmdbVideosSchema.optional(),
  'watch/providers': tmdbWatchProviderDetailSchema.optional(),
});

export const tmdbProviderListResponseSchema = z.object({
  results: z.array(tmdbProviderSchema).optional(),
});

export type TmdbCreditsResponse = z.infer<typeof tmdbDetailResponseSchema>['credits'];
export type TmdbCreditsPerson = NonNullable<NonNullable<TmdbCreditsResponse>['cast']>[number];
export type TmdbDetailResponse = z.infer<typeof tmdbDetailResponseSchema>;
export type TmdbListResult = z.infer<typeof tmdbListResultSchema>;
export type TmdbProvider = z.infer<typeof tmdbProviderSchema>;
export type TmdbVideo = NonNullable<z.infer<typeof tmdbVideosSchema>['results']>[number];
