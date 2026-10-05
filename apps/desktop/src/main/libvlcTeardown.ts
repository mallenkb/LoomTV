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

export async function waitForLibVlcTeardowns(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = async () => {
    while (inFlightTeardowns.size > 0) await Promise.allSettled([...inFlightTeardowns]);
    return true;
  };
  try {
    return await Promise.race([
      drained(),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
