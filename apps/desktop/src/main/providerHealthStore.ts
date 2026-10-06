import fs from 'node:fs/promises';
import path from 'node:path';
import { restoreProviderHealth } from './safeFetch.ts';

const FILE_NAME = 'provider-health.json';

/**
 * Keeps provider skip windows across restarts, so a metadata service that is
 * down is not waited on again by every launch's sync. The file is a few
 * hundred bytes and is written only when a provider is skipped or recovers.
 */
export async function startProviderHealthStore(userDataPath: string): Promise<void> {
  const file = path.join(userDataPath, FILE_NAME);
  let saved: unknown;
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first run or damaged file */ }
  let writing = Promise.resolve();
  restoreProviderHealth(saved, (state) => {
    writing = writing.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await fs.rename(temporary, file);
      } catch {
        await fs.unlink(temporary).catch(() => undefined);
      }
    });
  });
}
