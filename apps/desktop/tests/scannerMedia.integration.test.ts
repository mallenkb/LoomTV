import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { discoverLibraryRoot } from '../src/main/scanning/discover.ts';
import { scanInventory } from '../src/main/scanning/inventory.ts';
import { scanEpisodeFilesAsync } from '../src/main/libraryScanFiles.ts';
const run = promisify(execFile);
const enabled = Boolean(process.env.LOOM_TEST_FFMPEG && process.env.LOOM_TEST_FFPROBE);

test('both engines scan a valid video with a real ffprobe process', { skip: !enabled }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-valid-media-'));
  try {
    const file = path.join(root, 'Series.S01E02.mp4');
    await run(process.env.LOOM_TEST_FFMPEG || '', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1', '-t', '1', '-c:v', 'mpeg4', file]);
    const binary = path.resolve(import.meta.dirname, '../native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));
    for (const engine of ['typescript', 'rust'] as const) {
      const { inventory } = await discoverLibraryRoot(root, { engine, binary });
      try {
        const episodes = await scanInventory.run(inventory, () => scanEpisodeFilesAsync(root, async (filePath) => {
          const output = await run(process.env.LOOM_TEST_FFPROBE || '', ['-v', 'error', '-show_streams', '-of', 'json', filePath]);
          const parsed = JSON.parse(output.stdout);
          return { localMetadata: { videoCodec: parsed.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')?.codec_name } };
        }));
        assert.deepEqual(episodes.map((episode) => [episode.season, episode.episode]), [[1, 2]]);
        assert.equal(episodes[0].localMetadata?.videoCodec, 'mpeg4');
      } finally { inventory.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
