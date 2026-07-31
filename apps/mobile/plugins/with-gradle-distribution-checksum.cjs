const fs = require('node:fs/promises')
const path = require('node:path')
const { withDangerousMod } = require('expo/config-plugins')

const EXPECTED_DISTRIBUTION_URL =
  'https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip'
const EXPECTED_DISTRIBUTION_SHA256 =
  'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531'

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

      if (distributionUrl !== EXPECTED_DISTRIBUTION_URL) {
        throw new Error(
          `Unexpected Gradle distribution URL ${distributionUrl || '(missing)'}; ` +
            'update the pinned URL and checksum together.',
        )
      }

      const checksumLine = `distributionSha256Sum=${EXPECTED_DISTRIBUTION_SHA256}`
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
