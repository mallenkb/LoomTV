import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const currentSession = query({
  args: { hostId: v.id('hosts') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('playbackSessions')
      .withIndex('by_host', (q) => q.eq('hostId', args.hostId))
      .first();
  },
});

export const setSession = mutation({
  args: {
    hostId: v.id('hosts'),
    mediaId: v.optional(v.id('media')),
    state: v.union(v.literal('idle'), v.literal('playing'), v.literal('paused'), v.literal('stopped')),
    positionSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('playbackSessions')
      .withIndex('by_host', (q) => q.eq('hostId', args.hostId))
      .first();
    const nextSession = {
      hostId: args.hostId,
      mediaId: args.mediaId,
      state: args.state,
      positionSeconds: args.positionSeconds,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, nextSession);
      return existing._id;
    }
    return await ctx.db.insert('playbackSessions', nextSession);
  },
});

export const progressForHost = query({
  args: { hostId: v.id('hosts') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('playbackProgress')
      .withIndex('by_host_updated', (q) => q.eq('hostId', args.hostId))
      .collect();
  },
});

export const progressForFile = query({
  args: {
    hostId: v.id('hosts'),
    filePath: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('playbackProgress')
      .withIndex('by_host_file', (q) =>
        q.eq('hostId', args.hostId).eq('filePath', args.filePath),
      )
      .first();
  },
});

export const saveProgress = mutation({
  args: {
    hostId: v.id('hosts'),
    filePath: v.string(),
    mediaExternalId: v.optional(v.string()),
    episodeExternalId: v.optional(v.string()),
    positionSeconds: v.number(),
    durationSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const watched = args.durationSeconds > 0
      && (args.positionSeconds / args.durationSeconds >= 0.9 || args.durationSeconds - args.positionSeconds < 90);
    const existing = await ctx.db
      .query('playbackProgress')
      .withIndex('by_host_file', (q) =>
        q.eq('hostId', args.hostId).eq('filePath', args.filePath),
      )
      .first();
    const document = {
      hostId: args.hostId,
      filePath: args.filePath,
      mediaExternalId: args.mediaExternalId,
      episodeExternalId: args.episodeExternalId,
      positionSeconds: args.positionSeconds,
      durationSeconds: args.durationSeconds,
      watched,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, document);
      return existing._id;
    }
    return await ctx.db.insert('playbackProgress', document);
  },
});

export const sendCommand = mutation({
  args: {
    hostId: v.id('hosts'),
    mediaId: v.optional(v.id('media')),
    command: v.union(v.literal('play'), v.literal('pause'), v.literal('seek'), v.literal('stop')),
    positionSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('controlCommands', {
      hostId: args.hostId,
      mediaId: args.mediaId,
      command: args.command,
      positionSeconds: args.positionSeconds,
      createdAt: Date.now(),
    });
  },
});

export const listUnhandledCommands = query({
  args: { hostId: v.id('hosts') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('controlCommands')
      .withIndex('by_host_unhandled', (q) => q.eq('hostId', args.hostId).eq('handledAt', undefined))
      .collect();
  },
});

export const markCommandHandled = mutation({
  args: { commandId: v.id('controlCommands') },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.commandId, { handledAt: Date.now() });
  },
});
