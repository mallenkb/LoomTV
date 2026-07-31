import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export class TextFileTooLargeError extends Error {
  constructor() {
    super('Text file exceeds the configured byte limit.');
    this.name = 'TextFileTooLargeError';
  }
}

export async function readBoundedUtf8File(
  filePath: string,
  options: { maxBytes: number; chunkBytes?: number; signal?: AbortSignal },
): Promise<string> {
  const { maxBytes, signal } = options;
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Text byte limit must be non-negative.');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Text chunk size must be positive.');

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Text resource is not a regular file.');
    if (stats.size > maxBytes) throw new TextFileTooLargeError();

    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let bytesReadTotal = 0;
    const bodyChunks: string[] = [];
    while (!signal?.aborted) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return bodyChunks.join('') + decoder.end();
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > maxBytes) throw new TextFileTooLargeError();
      bodyChunks.push(decoder.write(chunk.subarray(0, bytesRead)));
    }
    throw new Error('Text request was cancelled.');
  } finally {
    await handle.close();
  }
}
