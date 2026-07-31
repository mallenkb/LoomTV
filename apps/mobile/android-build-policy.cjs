const ANDROID_BUILD_POLICY = Object.freeze({
  applicationId: 'app.loomtv.mobile',
  version: '1.0.1',
  versionCode: 1,
  gradleDistributionUrl:
    'https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip',
  gradleDistributionSha256:
    'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531',
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
});

module.exports = ANDROID_BUILD_POLICY;
