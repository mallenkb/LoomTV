export const sensitiveRedirectHeaders = {
  authorization: 'Bearer host-secret',
  cookie: 'session=host-secret',
  'x-api-key': 'provider-key',
  'x-config-secret': 'config-value',
  'x-request-id': 'safe-request-id',
} as const;

