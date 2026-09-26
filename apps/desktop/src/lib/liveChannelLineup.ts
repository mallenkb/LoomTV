/**
 * The channel list the viewer opened a live channel from, in the order they
 * saw it (search, group, and sort applied). The player steps through it for
 * next/previous channel and remembers the last channel for quick return.
 */
export type LineupChannel = {
  /** Playback reference, as passed to the player. */
  reference: string;
  name: string;
  logoUrl?: string;
};

let lineup: LineupChannel[] = [];
let current = '';
let previous = '';

export function setLiveLineup(channels: readonly LineupChannel[], playing: string): void {
  lineup = [...channels];
  noteLiveChannelPlaying(playing);
}

export function noteLiveChannelPlaying(reference: string): void {
  if (reference === current) return;
  if (current) previous = current;
  current = reference;
}

/** Position of a channel in the lineup (1-based) and the lineup size. */
export function livePosition(reference: string): { index: number; total: number } {
  return { index: lineup.findIndex((channel) => channel.reference === reference) + 1, total: lineup.length };
}

/** The channel `step` places away, wrapping around the ends. */
export function adjacentLiveChannel(reference: string, step: number): LineupChannel | null {
  if (lineup.length < 2) return null;
  const index = lineup.findIndex((channel) => channel.reference === reference);
  const start = index < 0 ? 0 : index;
  return lineup[(start + step + lineup.length) % lineup.length] || null;
}

/** The channel watched before this one, if it is still in the lineup. */
export function lastLiveChannel(reference: string): LineupChannel | null {
  if (!previous || previous === reference) return null;
  return lineup.find((channel) => channel.reference === previous) || null;
}
