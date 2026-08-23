const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withTvLauncher(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] || [];
    const features = manifest['uses-feature'];
    if (!features.some((entry) => entry.$?.['android:name'] === 'android.software.leanback')) {
      features.push({ $: { 'android:name': 'android.software.leanback', 'android:required': 'false' } });
    }
    if (!features.some((entry) => entry.$?.['android:name'] === 'android.hardware.touchscreen')) {
      features.push({ $: { 'android:name': 'android.hardware.touchscreen', 'android:required': 'false' } });
    }
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    application.$['android:banner'] = '@mipmap/ic_launcher';
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    const filters = activity['intent-filter'] || [];
    for (const filter of filters) {
      const categories = filter.category || [];
      const hasLauncher = categories.some((entry) => entry.$?.['android:name'] === 'android.intent.category.LAUNCHER');
      const hasLeanback = categories.some((entry) => entry.$?.['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER');
      if (hasLauncher && !hasLeanback) categories.push({ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } });
      filter.category = categories;
    }
    activity['intent-filter'] = filters;
    return next;
  });
};
