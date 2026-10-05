import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function ffmpegFixture(t, { hangSmokeTest = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-capabilities-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'ffmpeg');
  const callsFile = path.join(directory, 'calls.jsonl');
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (args.includes('-encoders')) console.log('h264_videotoolbox hevc_videotoolbox libx264 libx265 libsvtav1');
if (args.includes('-decoders') || args.includes('-hwaccels')) console.log('videotoolbox');
if (args.includes('-filters')) console.log('zscale tonemap');
if (args.includes('-frames:v') && ${hangSmokeTest}) setTimeout(() => {}, 10000);
`, { mode: 0o700 });
  return {
    binary,
    directory,
    options: { platform: 'darwin', cacheDir: path.join(directory, 'cache') },
    async calls() {
      return (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    },
  };
}
