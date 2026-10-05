type AsyncNativeFunction = {
  async: (handle: number | bigint, callback: (error: Error | null) => void) => void;
};

const inFlightTeardowns = new Set<Promise<void>>();

export function callLibVlcAsync(fn: AsyncNativeFunction, handle: number | bigint): Promise<void> {
  return new Promise((resolve, reject) => {
    fn.async(handle, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function trackLibVlcTeardown(operation: () => Promise<void>): Promise<void> {
  const pending = Promise.resolve().then(operation);
  inFlightTeardowns.add(pending);
  void pending.then(() => inFlightTeardowns.delete(pending), (error) => {
    inFlightTeardowns.delete(pending);
    console.warn('[libvlc] native teardown failed:', error instanceof Error ? error.message : error);
  });
  return pending;
}
