import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

function createPairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createDeviceToken(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export const registerHost = mutation({
  args: {
    name: v.string(),
    localBaseUrl: v.optional(v.string()),
    remoteBaseUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const hostId = await ctx.db.insert('hosts', {
      name: args.name.trim() || 'Loom Media Server Desktop',
      pairingCode: createPairingCode(),
      status: 'online',
      localBaseUrl: args.localBaseUrl,
      remoteBaseUrl: args.remoteBaseUrl,
      lastSeenAt: now,
      createdAt: now,
    });
    return await ctx.db.get(hostId);
  },
});

export const heartbeat = mutation({
  args: {
    hostId: v.id('hosts'),
    localBaseUrl: v.optional(v.string()),
    remoteBaseUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.hostId, {
      status: 'online',
      localBaseUrl: args.localBaseUrl,
      remoteBaseUrl: args.remoteBaseUrl,
      lastSeenAt: Date.now(),
    });
  },
});

export const rotatePairingCode = mutation({
  args: { hostId: v.id('hosts') },
  handler: async (ctx, args) => {
    const pairingCode = createPairingCode();
    await ctx.db.patch(args.hostId, { pairingCode });
    return pairingCode;
  },
});

export const pairByCode = mutation({
  args: {
    pairingCode: v.string(),
    deviceName: v.string(),
  },
  handler: async (ctx, args) => {
    const code = args.pairingCode.replace(/\D/g, '').slice(0, 6);
    const host = await ctx.db
      .query('hosts')
      .withIndex('by_pairing_code', (q) => q.eq('pairingCode', code))
      .first();

    if (!host || host.status !== 'online') {
      throw new Error('No online Loom Media Server host accepted that pairing code.');
    }

    const now = Date.now();
    const deviceToken = createDeviceToken();
    const pairedDeviceId = await ctx.db.insert('pairedDevices', {
      hostId: host._id,
      deviceName: args.deviceName.trim() || 'LoomTV Mobile',
      deviceToken,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      host,
      pairedDeviceId,
      deviceToken,
    };
  },
});

export const getHostForDevice = query({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query('pairedDevices')
      .withIndex('by_token', (q) => q.eq('deviceToken', args.deviceToken))
      .first();
    if (!device) return null;
    const host = await ctx.db.get(device.hostId);
    return host ? { host, device } : null;
  },
});
