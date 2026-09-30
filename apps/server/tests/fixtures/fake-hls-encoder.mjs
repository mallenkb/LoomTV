// Stands in for FFmpeg in pacing tests: writes one small HLS segment every
// 20 ms to the paths FFmpeg would use, so SIGSTOP and SIGCONT apply to a real
// process with a predictable production rate.
import fs from 'node:fs';

const args = process.argv.slice(2);
const pattern = args[args.indexOf('-hls_segment_filename') + 1];
const playlist = args.at(-1);
const total = 600;
let index = 0;
fs.writeFileSync(playlist, '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n');
const timer = setInterval(() => {
  const name = pattern.replace('%05d', String(index).padStart(5, '0'));
  fs.writeFileSync(name, Buffer.alloc(188));
  fs.appendFileSync(playlist, `#EXTINF:2.000000,\n${name.split('/').pop()}\n`);
  index += 1;
  if (index >= total) {
    fs.appendFileSync(playlist, '#EXT-X-ENDLIST\n');
    clearInterval(timer);
  }
}, 20);
