import { randomUUID } from 'node:crypto';

/**
 * Provider subtitle URLs can carry add-on credentials, so they stay in the
 * main process. The renderer receives an opaque token instead, bound to the
 * profile, add-on, and add-on revision that listed the subtitle.
 */
export type StremioSubtitleGrant = {
  profileId: string;
  addonId: string;
  revision: string;
  url: string;
  language: string;
};

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOKENS = 4_000;

export function createStremioSubtitleTokens(now: () => number = Date.now) {
  const grants = new Map<string, StremioSubtitleGrant & { expiresAt: number }>();

  const prune = () => {
    const time = now();
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= time) grants.delete(token);
    }
    // Map iteration follows insertion order, so the oldest grants go first.
    while (grants.size >= MAX_TOKENS) {
      const oldest = grants.keys().next().value;
      if (oldest === undefined) break;
      grants.delete(oldest);
    }
  };

  return {
    issue(grant: StremioSubtitleGrant): string {
      prune();
      const token = randomUUID();
      grants.set(token, { ...grant, expiresAt: now() + TOKEN_TTL_MS });
      return token;
    },
    /** The grant for a token issued to this profile, or null when unknown or expired. */
    resolve(token: string, profileId: string): StremioSubtitleGrant | null {
      const grant = grants.get(token);
      if (!grant || grant.expiresAt <= now() || grant.profileId !== profileId) return null;
      return grant;
    },
    clear(): void {
      grants.clear();
    },
  };
}
