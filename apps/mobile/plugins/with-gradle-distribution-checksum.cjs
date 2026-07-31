const fs = require('node:fs/promises')
const path = require('node:path')
const { withDangerousMod } = require('expo/config-plugins')
const ANDROID_BUILD_POLICY = require('../android-build-policy.cjs')

module.exports = function withGradleDistributionChecksum(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      if (modConfig.modRequest.introspect) return modConfig

      const wrapperPropertiesPath = path.join(
        modConfig.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties',
      )
      const original = await fs.readFile(wrapperPropertiesPath, 'utf8')
      const distributionUrl = original.match(/^distributionUrl=(.+)$/m)?.[1]

      if (distributionUrl !== ANDROID_BUILD_POLICY.gradleDistributionUrl) {
        throw new Error(
          `Unexpected Gradle distribution URL ${distributionUrl || '(missing)'}; ` +
            'update the pinned URL and checksum together.',
        )
      }

      const checksumLine = `distributionSha256Sum=${ANDROID_BUILD_POLICY.gradleDistributionSha256}`
      const updated = /^distributionSha256Sum=.*$/m.test(original)
        ? original.replace(/^distributionSha256Sum=.*$/m, checksumLine)
        : `${original.trimEnd()}\n${checksumLine}\n`

      if (updated !== original) {
        await fs.writeFile(wrapperPropertiesPath, updated)
      }

      return modConfig
    },
  ])
}
