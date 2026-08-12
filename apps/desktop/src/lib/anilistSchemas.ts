import { z } from 'zod';

const aniListNameSchema = z.object({ full: z.string().nullish() });
const aniListPersonImageSchema = z.object({
  medium: z.string().nullish(),
  large: z.string().nullish(),
});

export const aniListCharacterEdgeSchema = z.object({
  node: z.object({
    name: aniListNameSchema.nullish(),
    image: aniListPersonImageSchema.nullish(),
  }).nullish(),
  role: z.string().nullish(),
  voiceActors: z.array(z.object({
    name: aniListNameSchema.nullish(),
    image: aniListPersonImageSchema.nullish(),
    languageV2: z.string().nullish(),
  })).nullish(),
});

export const aniListMediaSchema = z.object({
  id: z.number().int(),
  title: z.object({
    userPreferred: z.string().optional(),
    english: z.string().optional(),
    native: z.string().optional(),
  }).optional(),
  description: z.string().nullish(),
  genres: z.array(z.string()).optional(),
  averageScore: z.number().nullish(),
  format: z.string().nullish(),
  duration: z.number().nullish(),
  startDate: z.object({
    year: z.number().nullish(),
    month: z.number().nullish(),
    day: z.number().nullish(),
  }).nullish(),
  coverImage: z.object({
    extraLarge: z.string().nullish(),
    large: z.string().nullish(),
    medium: z.string().nullish(),
  }).nullish(),
  bannerImage: z.string().nullish(),
  episodes: z.number().nullish(),
  characters: z.object({ edges: z.array(aniListCharacterEdgeSchema).optional() }).optional(),
  trailer: z.object({
    id: z.string().nullish(),
    site: z.string().nullish(),
  }).nullish(),
});

const aniListErrorsSchema = z.array(z.object({ message: z.string().optional() })).optional();

export const aniListDiscoverResponseSchema = z.object({
  data: z.object({
    Page: z.object({ media: z.array(aniListMediaSchema).optional() }).optional(),
  }).optional(),
  errors: aniListErrorsSchema,
});

export const aniListGenreResponseSchema = z.object({
  data: z.object({ GenreCollection: z.array(z.string()).optional() }).optional(),
  errors: aniListErrorsSchema,
});

export const aniListCastResponseSchema = z.object({
  data: z.object({
    Media: z.object({
      characters: z.object({ edges: z.array(aniListCharacterEdgeSchema).nullish() }).nullish(),
    }).nullish(),
  }).optional(),
  errors: aniListErrorsSchema,
});

export type AniListCharacterEdge = z.infer<typeof aniListCharacterEdgeSchema>;
export type AniListMediaResult = z.infer<typeof aniListMediaSchema>;
