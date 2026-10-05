// Run with an Electron executable, preferably with ELECTRON_RUN_AS_NODE unset.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function probeNativeImage() {
  let electron;
  try {
    electron = require('electron');
    const { nativeImage } = electron;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/dsAAAAASUVORK5CYII=', 'base64');
    const image = nativeImage.createFromBuffer(bytes);
    return { nativeImage: typeof nativeImage, empty: image.isEmpty(), size: image.getSize() };
  } catch (error) {
    return { electronModuleType: typeof electron, nativeImage: typeof electron?.nativeImage, error: error.message };
  }
}

async function probeWorker() {
  const worker = new Worker(`${probeNativeImage.toString()}
    require('node:worker_threads').parentPort.postMessage(probeNativeImage());
  `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    console.log(JSON.stringify({ worker: result }));
  } finally {
    await worker.terminate();
  }
}

if (process.type === 'utility') {
  // Keep the same require/decode operation in both off-thread candidates.
  process.parentPort.postMessage(probeNativeImage());
} else if (process.type === 'browser') {
  const { app, nativeImage, utilityProcess } = require('electron');
  app.setPath('userData', path.resolve(__dirname, '../../../.cache/artwork-electron-check'));
  app.whenReady().then(async () => {
    console.log(JSON.stringify({ electron: process.versions.electron, processType: process.type, nativeImage: typeof nativeImage, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? 'unset' }));
    await probeWorker();
    const child = utilityProcess.fork(__filename, [], { execArgv: ['--max-old-space-size=64'], stdio: 'inherit' });
    child.once('message', (result) => {
      console.log(JSON.stringify({ utilityProcess: result }));
      child.kill();
    });
    child.once('exit', (code) => {
      console.log(JSON.stringify({ utilityExit: code }));
      app.exit(0);
    });
  }).catch((error) => { console.error(error); app.exit(1); });
  setTimeout(() => { console.error('Artwork Electron check timed out'); app.exit(1); }, 10_000);
} else {
  // The npm Electron shim may otherwise download a binary during this check.
  process.env.ELECTRON_OVERRIDE_DIST_PATH ??= path.dirname(process.execPath);
  console.log(JSON.stringify({ electron: process.versions.electron, runAsNode: process.env.ELECTRON_RUN_AS_NODE, utilityProcess: 'requires a real Electron main process' }));
  probeWorker().catch((error) => { console.error(error); process.exitCode = 1; });
}
