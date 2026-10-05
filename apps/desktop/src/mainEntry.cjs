const { app } = require('electron');
const path = require('node:path');
const { enableCompileCache } = require('node:module');

// Resolve the credential-store identity and data override before loading any
// application modules. Keep this entry separate from the large Vite bundle.
app.setName('LoomTV');
const configuredUserDataDir = String(process.env.LOOMTV_DATA_DIR || '').trim();
const userData = configuredUserDataDir
  ? path.resolve(configuredUserDataDir)
  : path.join(app.getPath('appData'), 'LoomTV');
app.setPath('userData', userData);

// A disabled or unwritable cache must never stop the application launching.
try { enableCompileCache(path.join(userData, 'v8-compile-cache')); } catch {}
require('./main-bundle.js');
