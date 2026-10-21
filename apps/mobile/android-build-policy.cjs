const ANDROID_BUILD_POLICY = Object.freeze({
  applicationId: 'app.loomtv.mobile',
  version: '1.0.1',
  versionCode: 1,
  gradleDistributionUrl:
    'https\\://services.gradle.org/distributions/gradle-9.4.1-bin.zip',
  gradleDistributionSha256:
    '2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb',
  networkSecurityConfigResource: '@xml/loomtv_network_security_config',
  networkSecurityConfig: `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`,
  debugNetworkSecurityConfig: `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`,
});

module.exports = ANDROID_BUILD_POLICY;
