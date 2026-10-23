const REFERENCE = /^addon:\/\/stream\/([a-f0-9-]{36})$/;

/** An opaque host grant, never a provider URL or a general network capability. */
export function addonPlaybackReference(token: string): string {
  return `addon://stream/${token}`;
}

export function parseAddonPlaybackReference(value: string): string | null {
  return REFERENCE.exec(value)?.[1] ?? null;
}

export function isAddonRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/addon-media\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{24}\.(?:media|m3u8|key)$/.test(url.pathname);
  } catch { return false; }
}
