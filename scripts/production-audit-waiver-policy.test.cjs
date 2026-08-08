const assert = require('node:assert/strict')
const { describe, test } = require('node:test')

const {
  orphanedWaiverIds,
  validateAuditInvocation,
  validateAuditReport,
  validateWaiver,
} = require('./production-audit-waiver-policy.cjs')

const advisory = {
  module_name: 'image-size',
  findings: [
    {
      paths: [
        'apps__mobile>expo>@expo/metro>metro>image-size',
        'apps__mobile>expo>react-native>@react-native/community-cli-plugin>metro-config>metro>image-size',
      ],
    },
  ],
}

const waiver = {
  module: 'image-size',
  reviewedOn: '2026-08-08',
  expires: '2026-11-06',
  owner: '@mallenkb',
  reason: 'Temporary, narrowly scoped exception with a defined removal condition.',
  allowedPathPrefixes: ['apps__mobile>'],
  requiredPathMarkers: ['>metro>image-size'],
}

function withPath(dependencyPath) {
  return {
    ...advisory,
    findings: [{ paths: [dependencyPath] }],
  }
}

describe('production audit waiver policy', () => {
  test('accepts only the documented mobile Metro image-size scope', () => {
    assert.equal(validateWaiver(advisory, waiver, '2026-08-08T00:00:00Z'), null)
  })

  test('rejects an expired waiver', () => {
    assert.equal(
      validateWaiver(advisory, waiver, '2026-11-07T00:00:00Z'),
      'waiver expired on 2026-11-06',
    )
  })

  test('accepts a waiver through the final millisecond of its UTC expiry date', () => {
    assert.equal(validateWaiver(advisory, waiver, '2026-11-06T23:59:59.999Z'), null)
  })

  test('rejects an impossible calendar expiry', () => {
    assert.equal(
      validateWaiver(advisory, { ...waiver, expires: '2026-02-31' }, '2026-02-01'),
      'waiver expiry must use YYYY-MM-DD',
    )
  })

  test('rejects a waiver validity window longer than 90 days', () => {
    assert.equal(
      validateWaiver(advisory, { ...waiver, expires: '2026-11-07' }, '2026-08-08'),
      'waiver validity must be between 1 and 90 days',
    )
  })

  test('rejects a waiver before its recorded review date', () => {
    assert.equal(
      validateWaiver(advisory, waiver, '2026-08-07T23:59:59.999Z'),
      'waiver review date 2026-08-08 is in the future',
    )
  })

  test('rejects a module mismatch', () => {
    assert.equal(
      validateWaiver({ ...advisory, module_name: 'other-module' }, waiver, '2026-08-08'),
      'module changed from image-size to other-module',
    )
  })

  test('rejects a dependency path outside apps/mobile', () => {
    assert.equal(
      validateWaiver(
        withPath('apps__desktop>some-package>metro>image-size'),
        waiver,
        '2026-08-08',
      ),
      'dependency path escaped the documented scope',
    )
  })

  test('rejects a mobile dependency path without the Metro marker', () => {
    assert.equal(
      validateWaiver(withPath('apps__mobile>some-package>image-size'), waiver, '2026-08-08'),
      'dependency path is missing a required scope marker',
    )
  })

  test('rejects a lookalike package that only contains the required marker as a substring', () => {
    assert.equal(
      validateWaiver(withPath('apps__mobile>some-package>metro>image-size-lookalike'), waiver, '2026-08-08'),
      'dependency path does not terminate at the waived module',
    )
  })

  test('rejects malformed paths even when another reported path is valid', () => {
    assert.equal(
      validateWaiver(
        {
          ...advisory,
          findings: [{ paths: [...advisory.findings[0].paths, 'apps__mobile>>metro>image-size'] }],
        },
        waiver,
        '2026-08-08',
      ),
      'advisory dependency paths are missing or malformed',
    )
  })

  test('rejects a finding that omits its paths beside an otherwise valid finding', () => {
    assert.equal(
      validateWaiver(
        { ...advisory, findings: [...advisory.findings, {}] },
        waiver,
        '2026-08-08',
      ),
      'advisory dependency paths are missing or malformed',
    )
  })

  test('rejects unexpected pnpm audit process outcomes', () => {
    assert.equal(validateAuditInvocation(2, null), 'pnpm audit exited with unexpected status 2')
    assert.equal(validateAuditInvocation(null, 'SIGTERM'), 'pnpm audit was terminated by signal SIGTERM')
    assert.equal(validateAuditInvocation(1, null), null)
  })

  test('rejects malformed advisory metadata instead of dropping it below the severity gate', () => {
    assert.equal(
      validateAuditReport({
        advisories: {
          1234: {
            github_advisory_id: 'GHSA-example',
            module_name: 'example',
            severity: 'unknown',
          },
        },
      }),
      'pnpm audit returned invalid metadata for advisory 1234',
    )
  })

  test('accepts pnpm internal report keys while requiring unique GHSA IDs', () => {
    assert.equal(
      validateAuditReport({
        advisories: {
          1234: {
            github_advisory_id: 'GHSA-example',
            module_name: 'example',
            severity: 'high',
          },
        },
      }),
      null,
    )
    assert.equal(
      validateAuditReport({
        advisories: {
          1234: {
            github_advisory_id: 'GHSA-example',
            module_name: 'example',
            severity: 'high',
          },
          5678: {
            github_advisory_id: 'GHSA-example',
            module_name: 'example',
            severity: 'high',
          },
        },
      }),
      'pnpm audit returned invalid metadata for advisory 5678',
    )
  })

  test('identifies stale waivers after their advisories disappear', () => {
    assert.deepEqual(
      orphanedWaiverIds(
        [{ github_advisory_id: 'GHSA-current' }],
        { 'GHSA-current': {}, 'GHSA-stale': {} },
      ),
      ['GHSA-stale'],
    )
  })
})
