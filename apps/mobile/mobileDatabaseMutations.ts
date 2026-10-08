let mutations: Promise<unknown> = Promise.resolve();

// Snapshot transactions and download publication share one write owner. Separate
// native connections keep reads isolated; this queue also avoids writer contention.
export function serializeMobileDatabaseMutation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = mutations.catch(() => undefined).then(operation);
  mutations = pending;
  return pending;
}
