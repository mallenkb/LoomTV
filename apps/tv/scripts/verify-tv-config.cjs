const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
assert.equal(config.orientation, 'landscape');
assert.equal(config.android.usesCleartextTraffic, false);
assert.equal(config.android.allowBackup, false);
assert.deepEqual(config.android.permissions.sort(), [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  'android.permission.INTERNET',
]);
assert.ok(config.plugins.includes('./plugins/with-tv-launcher.cjs'));
assert.equal(config.android.package, 'app.loomtv.tv');
const plugin = fs.readFileSync(path.join(root, 'plugins', 'with-tv-launcher.cjs'), 'utf8');
assert.match(plugin, /LEANBACK_LAUNCHER/);
assert.match(plugin, /android\.hardware\.touchscreen/);
const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
assert.equal(eas.build.production.android.buildType, 'app-bundle');
assert.equal(eas.build.production.autoIncrement, true);
assert.ok(fs.existsSync(path.join(root, 'RELEASE_CHECKLIST.md')));
console.log('TV configuration is remote-first and least-privilege.');
