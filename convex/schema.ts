import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  hosts: defineTable({
    name: v.string(),
    pairingCode: v.string(),
    status: v.union(v.literal('online'), v.literal('offline')),
    localBaseUrl: v.optional(v.string()),
    remoteBaseUrl: v.optional(v.string()),
    lastSeenAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_pairing_code', ['pairingCode'])
    .index('by_status', ['status']),

  pairedDevices: defineTable({
    hostId: v.id('hosts'),
    deviceName: v.string(),
    deviceToken: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index('by_host', ['hostId'])
    .index('by_token', ['deviceToken']),

  media: defineTable({
    hostId: v.id('hosts'),
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
    updatedAt: v.number(),
  })
    .index('by_host', ['hostId'])
    .index('by_host_external_id', ['hostId', 'externalId']),

  episodes: defineTable({
    hostId: v.id('hosts'),
    mediaExternalId: v.string(),
    externalId: v.string(),
    season: v.number(),
    episode: v.number(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    stillUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    streamUrl: v.string(),
    durationSeconds: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_host_media', ['hostId', 'mediaExternalId'])
    .index('by_host_external_id', ['hostId', 'externalId']),

  playbackSessions: defineTable({
    hostId: v.id('hosts'),
    mediaId: v.optional(v.id('media')),
    state: v.union(v.literal('idle'), v.literal('playing'), v.literal('paused'), v.literal('stopped')),
    positionSeconds: v.number(),
    updatedAt: v.number(),
  }).index('by_host', ['hostId']),

  playbackProgress: defineTable({
    hostId: v.id('hosts'),
    filePath: v.string(),
    mediaExternalId: v.optional(v.string()),
    episodeExternalId: v.optional(v.string()),
    positionSeconds: v.number(),
    durationSeconds: v.number(),
    watched: v.boolean(),
    updatedAt: v.number(),
  })
    .index('by_host_file', ['hostId', 'filePath'])
    .index('by_host_updated', ['hostId', 'updatedAt']),

  controlCommands: defineTable({
    hostId: v.id('hosts'),
    mediaId: v.optional(v.id('media')),
    command: v.union(v.literal('play'), v.literal('pause'), v.literal('seek'), v.literal('stop')),
    positionSeconds: v.optional(v.number()),
    createdAt: v.number(),
    handledAt: v.optional(v.number()),
  }).index('by_host_unhandled', ['hostId', 'handledAt']),
});
