const { withAndroidManifest } = require('expo/config-plugins');

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
    const application = manifest.application?.[0];
    if (!application) throw new Error('AndroidManifest.xml is missing the application element');
    application.$['android:banner'] = '@mipmap/ic_launcher';
    let hasMainLauncher = false;
    for (const activity of application.activity || []) {
      for (const filter of activity['intent-filter'] || []) {
        const actions = filter.action || [];
        const categories = filter.category || [];
        const isMainLauncher = actions.some(
          (entry) => entry.$?.['android:name'] === 'android.intent.action.MAIN',
        ) && categories.some(
          (entry) => entry.$?.['android:name'] === 'android.intent.category.LAUNCHER',
        );
        if (isMainLauncher) hasMainLauncher = true;
        const hasLeanback = categories.some(
          (entry) => entry.$?.['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER',
        );
        if (isMainLauncher && !hasLeanback) {
          categories.push({ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } });
        }
        filter.category = categories;
      }
    }
    if (!hasMainLauncher) throw new Error('AndroidManifest.xml is missing the main launcher intent filter');
    return next;
  });
};
