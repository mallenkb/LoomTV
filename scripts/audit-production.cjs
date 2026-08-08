const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  orphanedWaiverIds,
  plainRecord,
  validateAuditInvocation,
  validateAuditReport,
  validateWaiver,
} = require('./production-audit-waiver-policy.cjs')

const workspaceRoot = path.resolve(__dirname, '..')
const waiverPath = path.join(workspaceRoot, 'security', 'production-audit-waivers.json')
const waiverDocument = JSON.parse(fs.readFileSync(waiverPath, 'utf8'))
if (!plainRecord(waiverDocument.advisories)) {
  console.error('Production-audit waiver document must contain an advisories object')
  process.exit(1)
}
const waivers = waiverDocument.advisories

const audit = spawnSync('corepack', ['pnpm', 'audit', '--prod', '--json'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (audit.error) {
  throw audit.error
}

const invocationError = validateAuditInvocation(audit.status, audit.signal)
if (invocationError) {
  process.stderr.write(audit.stderr || `${invocationError}\n`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(audit.stdout)
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'pnpm audit returned no report\n')
  process.exit(audit.status || 1)
}

if (report.error) {
  console.error(`pnpm audit failed: ${report.error.message || JSON.stringify(report.error)}`)
  process.exit(1)
}

const reportError = validateAuditReport(report)
if (reportError) {
  console.error(reportError)
  process.exit(1)
}

function escapeWorkflowCommand(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

const advisories = Object.values(report.advisories || {})
const gatedSeverities = new Set(['moderate', 'high', 'critical'])
const gatedAdvisories = advisories.filter((advisory) => gatedSeverities.has(advisory.severity))
const actionable = []
const acceptedWaivers = []

const staleWaiverIds = orphanedWaiverIds(advisories, waivers)
if (staleWaiverIds.length > 0) {
  console.error(
    `Remove stale production-audit waiver(s) no longer reported by pnpm: ${staleWaiverIds.join(', ')}`,
  )
  process.exit(1)
}

for (const advisory of gatedAdvisories) {
  const advisoryId = advisory.github_advisory_id
  const waiver = waivers[advisoryId]
  if (!waiver) {
    actionable.push({ advisory, reason: 'no waiver' })
    continue
  }

  const invalidReason = validateWaiver(advisory, waiver)
  if (invalidReason) {
    actionable.push({ advisory, reason: invalidReason })
    continue
  }

  acceptedWaivers.push({ advisory, waiver })
}

for (const { advisory, waiver } of acceptedWaivers) {
  const message =
    `WAIVED until ${waiver.expires}: ${advisory.github_advisory_id} ` +
    `(${advisory.module_name}, owner ${waiver.owner}) — ${waiver.reason}`
  console.warn(message)
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${escapeWorkflowCommand(message)}`)
  }
}

if (actionable.length === 0) {
  console.log(
    `Workspace production audit passed: 0 actionable moderate-or-higher advisories, ` +
      `${acceptedWaivers.length} narrowly scoped waiver(s), ${advisories.length} total ` +
      `advisory record(s).`,
  )
  process.exit(0)
}

for (const { advisory, reason } of actionable) {
  console.error(
    `${advisory.severity}: ${advisory.github_advisory_id} ${advisory.module_name} — ` +
      `${advisory.title} (${reason})`,
  )
}

console.error(`Workspace production audit failed with ${actionable.length} advisory finding(s).`)
process.exit(1)
