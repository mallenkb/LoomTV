export type SessionBinding = { lastAccessAt: number };
export type SessionDisposalSubscription = (listener: (sessionId: string) => void) => () => void;

export function createSessionBindingStore<T extends SessionBinding>(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Session binding limit must be positive.');
  const bindings = new Map<string, T>();

  const remove = (sessionId: string): boolean => bindings.delete(sessionId);

  return {
    bind(sessionId: string, binding: Omit<T, 'lastAccessAt'>, now = Date.now()): void {
      bindings.delete(sessionId);
      while (bindings.size >= limit) {
        let oldest: [string, T] | undefined;
        for (const entry of bindings) {
          if (!oldest || entry[1].lastAccessAt < oldest[1].lastAccessAt) oldest = entry;
        }
        if (!oldest) break;
        bindings.delete(oldest[0]);
      }
      bindings.set(sessionId, { ...binding, lastAccessAt: now } as T);
    },
    get(sessionId: string): T | undefined {
      return bindings.get(sessionId);
    },
    touch(sessionId: string, now = Date.now()): T | undefined {
      const binding = bindings.get(sessionId);
      if (binding) binding.lastAccessAt = now;
      return binding;
    },
    remove,
    bindDisposal(subscribe: SessionDisposalSubscription): () => void {
      return subscribe(remove);
    },
    size(): number {
      return bindings.size;
    },
  };
}
