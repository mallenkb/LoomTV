export type NativeOwnerSession = { adminToken: string; expiresAt: number };

type NativeOwnerSessionOptions = {
  /** Asks the in-process canonical host for a fresh, expiring owner session. */
  issue: () => Promise<NativeOwnerSession>;
  now?: () => number;
  /** Renew this long before expiry so a request never starts with a nearly dead token. */
  renewBeforeMs?: number;
};

/**
 * Holds the unified desktop host's owner session. It renews the session
 * before expiry, shares one renewal between concurrent callers, retries a
 * request once after a 401, and ignores renewals that finish after reset().
 */
export function createNativeOwnerSession(options: NativeOwnerSessionOptions) {
  const now = options.now ?? Date.now;
  const renewBeforeMs = options.renewBeforeMs ?? 30_000;
  let token: string | null = null;
  let expiresAt = 0;
  let renewal: Promise<string> | null = null;
  // Bumped by reset() so a renewal started for a stopped host is discarded.
  let generation = 0;

  function accept(session: NativeOwnerSession): string {
    if (!session.adminToken || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) {
      throw new Error('The unified desktop host returned an expired native session.');
    }
    token = session.adminToken;
    expiresAt = session.expiresAt;
    return session.adminToken;
  }

  async function current(): Promise<string> {
    if (token && expiresAt > now() + renewBeforeMs) return token;
    if (renewal) return renewal;
    const started = generation;
    const pending = options.issue().then((session) => {
      if (started !== generation) throw new Error('The unified desktop host changed during authentication.');
      return accept(session);
    });
    renewal = pending;
    try {
      return await pending;
    } finally {
      if (renewal === pending) renewal = null;
    }
  }

  return {
    /** Records a session issued elsewhere, such as during owner setup. */
    set(session: NativeOwnerSession): void { accept(session); },
    reset(): void {
      generation += 1;
      token = null;
      expiresAt = 0;
      renewal = null;
    },
    token: current,
    /**
     * Sends with a current token. A 401 means the server revoked or expired it
     * early; authentication runs before any mutation, so one retry with a
     * fresh session cannot apply a change twice.
     */
    async send<T>(request: (token: string) => Promise<T>): Promise<T> {
      const first = await current();
      try {
        return await request(first);
      } catch (error) {
        if ((error as { status?: number } | null)?.status !== 401) throw error;
        if (token === first) {
          token = null;
          expiresAt = 0;
        }
        return request(await current());
      }
    },
  };
}
