import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

const mediaItem = v.object({
  externalId: v.string(),
  type: v.union(v.literal('movie'), v.literal('tv'), v.literal('anime')),
  title: v.string(),
  year: v.optional(v.number()),
  summary: v.optional(v.string()),
  posterUrl: v.optional(v.string()),
  backdropUrl: v.optional(v.string()),
  logoUrl: v.optional(v.string()),
  rating: v.optional(v.number()),
  genres: v.optional(v.array(v.string())),
  providerIds: v.optional(v.object({
    tmdbId: v.optional(v.string()),
    imdbId: v.optional(v.string()),
    tvdbId: v.optional(v.string()),
  })),
  streamUrl: v.string(),
  durationSeconds: v.optional(v.number()),
  episodes: v.optional(v.array(v.object({
    externalId: v.string(),
    season: v.number(),
    episode: v.number(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    stillUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    streamUrl: v.string(),
    durationSeconds: v.optional(v.number()),
  }))),
});

export const listForHost = query({
  args: { hostId: v.id('hosts') },
  handler: async (ctx, args) => {
    const media = await ctx.db
      .query('media')
      .withIndex('by_host', (q) => q.eq('hostId', args.hostId))
      .collect();

    const episodes = await Promise.all(media.map(async (item) => ({
      mediaExternalId: item.externalId,
      episodes: await ctx.db
        .query('episodes')
        .withIndex('by_host_media', (q) =>
          q.eq('hostId', args.hostId).eq('mediaExternalId', item.externalId),
        )
        .collect(),
    })));
    const episodesByMedia = new Map(episodes.map((entry) => [entry.mediaExternalId, entry.episodes]));
    return media.map((item) => ({ ...item, episodes: episodesByMedia.get(item.externalId) || [] }));
  },
});

export const upsertForHost = mutation({
  args: {
    hostId: v.id('hosts'),
    items: v.array(mediaItem),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const item of args.items) {
      const existing = await ctx.db
        .query('media')
        .withIndex('by_host_external_id', (q) =>
          q.eq('hostId', args.hostId).eq('externalId', item.externalId),
        )
        .first();

      const document = {
        hostId: args.hostId,
        externalId: item.externalId,
        type: item.type,
        title: item.title,
        year: item.year,
        summary: item.summary,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        logoUrl: item.logoUrl,
        rating: item.rating,
        genres: item.genres,
        providerIds: item.providerIds,
        streamUrl: item.streamUrl,
        durationSeconds: item.durationSeconds,
        updatedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, document);
      } else {
        await ctx.db.insert('media', document);
      }

      for (const episode of item.episodes || []) {
        const existingEpisode = await ctx.db
          .query('episodes')
          .withIndex('by_host_external_id', (q) =>
            q.eq('hostId', args.hostId).eq('externalId', episode.externalId),
          )
          .first();
        const episodeDocument = {
          hostId: args.hostId,
          mediaExternalId: item.externalId,
          ...episode,
          updatedAt: now,
        };
        if (existingEpisode) {
          await ctx.db.patch(existingEpisode._id, episodeDocument);
        } else {
          await ctx.db.insert('episodes', episodeDocument);
        }
      }
    }
  },
});
