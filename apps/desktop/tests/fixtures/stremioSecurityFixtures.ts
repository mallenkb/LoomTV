export const sensitiveRedirectHeaders = {
  authorization: 'Bearer host-secret',
  cookie: 'session=host-secret',
  'x-api-key': 'provider-key',
  'x-config-secret': 'config-value',
  'x-request-id': 'safe-request-id',
} as const;

export const opaqueDiscoverItem = {
  id: 'loomtv-stremio-item-v1.b3JnLmV4YW1wbGU.bW92aWU.dHQxMjM',
  type: 'movie',
  title: 'Fixture movie',
  genres: ['Drama'],
} as const;

export const artworkLimitsFixture = {
  maxInputBytes: 5 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxDimension: 8_192,
  maxPixels: 32_000_000,
  maxFrames: 1,
} as const;
