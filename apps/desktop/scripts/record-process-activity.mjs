import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

const [output, rootText, durationText = '90'] = process.argv.slice(2);
const root = Number(rootText);
const duration = Number(durationText);
if (!output || !Number.isInteger(root) || !Number.isFinite(duration) || duration < 1 || duration > 600) throw new Error('Provide output, root PID and duration in seconds.');
const started = Date.now();
const samples = [];
while (Date.now() - started < duration * 1000) {
  const tree = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), name: match[3].split('/').pop() } : null;
  }).filter(Boolean);
  const selected = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of tree) if (selected.has(process.parent) && !selected.has(process.pid)) { selected.add(process.pid); changed = true; }
  }
  const processes = tree.filter(process => selected.has(process.pid));
  if (!processes.some(process => process.pid === root)) break;
  const raw = execFileSync('top', ['-l', '2', '-s', '1', ...processes.flatMap(process => ['-pid', String(process.pid)]), '-stats', 'pid,command,cpu,mem,threads'], { encoding: 'utf8', timeout: 15000 });
  const table = raw.slice(raw.lastIndexOf('PID ')).trim().split('\n').slice(1);
  const rows = table.map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)([BKMG])[-+]?\s+(\d+)/);
    if (!match) return null;
    const pid = Number(match[1]);
    return { pid, name: processes.find(process => process.pid === pid)?.name || match[2], cpuPercent: Number(match[3]),
      footprintBytes: Number(match[4]) * ({ B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[5]]), threads: Number(match[6]) };
  }).filter(Boolean);
  samples.push({ timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, processes: rows });
  await fs.writeFile(output, JSON.stringify({ root, started: new Date(started).toISOString(),
    note: 'macOS top MEM footprint and interval CPU, second top sample each time. Running app and descendants only. Rounded OS display values; not ps RSS. CPU can exceed 100% across cores. Simulation runs separately and may compete for CPU.', samples }, null, 2));
  await new Promise(resolve => setTimeout(resolve, 3000));
}
console.log(JSON.stringify({ output, samples: samples.length, elapsedSeconds: (Date.now() - started) / 1000 }));
