const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');
const contract = require('../native/scanner/protocol-contract.json');

const executable = path.resolve(process.argv[2]);

async function verify(cancel, fingerprint = false, inspect = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scanner-check-'));
  fs.writeFileSync(path.join(root, 'sample.mp4'), 'scanner fixture');
  const metadata = fs.statSync(path.join(root, 'sample.mp4'), { bigint: true });
  const digest = createHash('sha256').update(JSON.stringify(['sample.mp4', String(metadata.size), String(metadata.mtimeNs / 1_000_000n)]) + '\n').digest('hex');
  if (cancel) for (let index = 0; index < 300; index++) fs.writeFileSync(path.join(root, `${index}.mp4`), 'fixture');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const id = cancel ? 'packaged-cancel' : 'packaged-discovery';
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let complete = false;
      let cancelled = false;
      let files = 0;
      let cancelSent = false;
      let failure;
      const timer = setTimeout(() => { failure ||= new Error('Scanner verification timed out.'); child.kill('SIGKILL'); }, 10_000);
      const send = (value) => child.stdin.write(JSON.stringify({ version: contract.version, id, ...value }) + '\n');
      const fail = (error) => { failure ||= error; child.kill(); };
      child.stderr.resume();
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', (data) => {
        pending += decoder.write(data);
        if (Buffer.byteLength(pending) > contract.maxFrameBytes) return fail(new Error('Scanner frame exceeds limit.'));
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.version !== contract.version || event.id !== id) throw new Error('Invalid scanner response.');
            if (event.kind === 'ready') {
              if (!['discovery', 'ack', 'cancel', 'signature', 'fingerprint', 'inspect'].every((capability) => event.capabilities.includes(capability))) throw new Error('Missing scanner capability.');
              send({ kind: inspect ? 'inspect' : fingerprint ? 'fingerprint' : 'discover', root, extensions: ['.mp4'], max_year: new Date().getFullYear() + 1,
                ...(inspect ? { expected_signature: fingerprint ? `inventory-v1:1:${digest}` : `inventory-v1:0:${'0'.repeat(64)}` } : {}) });
            }
            else if (event.kind === 'batch') {
              if (fingerprint) throw new Error('Unexpected inventory during signature check.');
              files += event.entries.filter((entry) => entry.path === path.join(root, 'sample.mp4')).length;
              if (cancel && !cancelSent) { cancelSent = true; send({ kind: 'cancel' }); }
              else send({ kind: 'ack', sequence: event.sequence });
            } else if (event.kind === 'complete') {
              if (!cancel && (event.fileCount !== 1 || event.signature !== `inventory-v1:1:${digest}`)) throw new Error('Scanner signature does not match fixture.');
              complete = true;
            }
            else if (event.kind === 'cancelled') cancelled = true;
            else if (event.kind === 'error') throw new Error(event.message);
          } catch (error) { fail(error); }
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0 || (cancel ? !cancelled || !cancelSent || complete : !complete || files !== (fingerprint ? 0 : 1))) reject(new Error('Scanner runtime verification failed.'));
        else resolve();
      });
      send({ kind: 'hello' });
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

verify(false).then(() => verify(true)).then(() => verify(false, true)).then(() => verify(false, true, true)).then(() => verify(false, false, true)).then(() => {
  console.log('Scanner handshake, discovery, signature check, changed and unchanged inspection, and cancellation passed.');
}).catch((error) => { console.error(error); process.exitCode = 1; });
