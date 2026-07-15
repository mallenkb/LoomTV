export type PlaybackClock = {
  mode: 'absolute' | 'offset';
  offsetSeconds: number;
};

export function absoluteMediaSeconds(playerSeconds: number, clock: PlaybackClock): number {
  const safePlayerSeconds = Number.isFinite(playerSeconds) ? Math.max(0, playerSeconds) : 0;
  return clock.mode === 'offset' ? clock.offsetSeconds + safePlayerSeconds : safePlayerSeconds;
}

export function playerSecondsForAbsolute(mediaSeconds: number, clock: PlaybackClock): number {
  const safeMediaSeconds = Number.isFinite(mediaSeconds) ? Math.max(0, mediaSeconds) : 0;
  return Math.max(0, clock.mode === 'offset' ? safeMediaSeconds - clock.offsetSeconds : safeMediaSeconds);
}
