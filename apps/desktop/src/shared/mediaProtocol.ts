export const PRIMARY_MEDIA_PROTOCOL_SCHEME = 'loomtv' as const;
export const LEGACY_MEDIA_PROTOCOL_SCHEME = 'plexserver' as const;

/**
 * New media URLs use LoomTV's name. The legacy alias remains readable so a
 * cached library payload or already-open player can finish without a prompt.
 */
export const MEDIA_PROTOCOL_SCHEMES = [
  PRIMARY_MEDIA_PROTOCOL_SCHEME,
  LEGACY_MEDIA_PROTOCOL_SCHEME,
] as const;

const MEDIA_PROTOCOL_URL_PATTERN = /^(?:loomtv|plexserver):\/\//i;

export function isMediaProtocolUrl(value: string): boolean {
  return MEDIA_PROTOCOL_URL_PATTERN.test(value);
}

export function remoteMediaProtocolUrl(route: string): string {
  return `${PRIMARY_MEDIA_PROTOCOL_SCHEME}://remote${route}`;
}
