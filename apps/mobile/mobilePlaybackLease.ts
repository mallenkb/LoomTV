type Renewal = { expiresAt: number; absoluteExpiresAt?: number; playlistUrl?: string; directUrl?: string };

export function ownMobilePlaybackLease({ expiresAt, absoluteExpiresAt, renew, stop, onRenewed, onFailure,
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
}: {
  expiresAt: number;
  absoluteExpiresAt?: number;
  renew: () => Promise<Renewal>;
  stop: () => Promise<unknown>;
  onRenewed: (result: Renewal, isCurrent: () => boolean) => Promise<void>;
  onFailure: (error: unknown) => void;
  now?: () => number;
  schedule?: typeof setTimeout;
  unschedule?: typeof clearTimeout;
}) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;
  let stopped: Promise<unknown> | undefined;
  const isCurrent = () => !closed;
  const arm = () => {
    if (closed) return;
    const deadline = Math.min(expiresAt, absoluteExpiresAt ?? Infinity);
    timer = schedule(() => { void tick(); }, Math.max(1000, deadline - now() - 60_000));
  };
  const tick = async () => {
    try {
      if (absoluteExpiresAt !== undefined && now() >= absoluteExpiresAt) throw new Error('Playback authorization expired.');
      const renewed = await renew();
      if (closed) return;
      await onRenewed(renewed, isCurrent);
      expiresAt = renewed.expiresAt;
      // The original absolute lifetime cannot be extended by a renewal.
      absoluteExpiresAt = Math.min(absoluteExpiresAt ?? Infinity, renewed.absoluteExpiresAt ?? Infinity);
      arm();
    } catch (error) {
      if (!closed) onFailure(error);
    }
  };
  arm();
  return {
    close() {
      closed = true;
      unschedule(timer);
      stopped ??= stop();
      return stopped;
    },
  };
}
