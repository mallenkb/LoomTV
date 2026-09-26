/**
 * A channel name without the playlist's release and status tags:
 * "Jordan Sport (1080p) [Geo-blocked]" shows as "Jordan Sport". Whether a
 * channel plays is decided by verification, so the tags only add noise.
 * Search still runs against the full stored name.
 */
const TAG = /\s*[[(](?:\d{3,4}[pi]|4k|uhd|fhd|hd|sd|geo-blocked|not 24\/7)[\])]/gi;

export function displayChannelName(name: string): string {
  const cleaned = name.replace(TAG, '').replace(/\s+/g, ' ').trim();
  return cleaned || name.trim();
}
