const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const workspaceRoot = path.resolve(__dirname, '..')
const waiverPath = path.join(workspaceRoot, 'security', 'production-audit-waivers.json')
const waiverDocument = JSON.parse(fs.readFileSync(waiverPath, 'utf8'))
const waivers = waiverDocument.advisories || {}

const audit = spawnSync('corepack', ['pnpm', 'audit', '--prod', '--json'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (audit.error) {
  throw audit.error
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

function listSourceFiles(sourceRoot) {
  const files = []
  const pending = [sourceRoot]

  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }

  return files
}

function validateWaiver(advisory, waiver) {
  if (waiver.module !== advisory.module_name) {
    return `module changed from ${waiver.module} to ${advisory.module_name}`
  }

  const expiry = Date.parse(`${waiver.expires}T23:59:59Z`)
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return `waiver expired on ${waiver.expires}`
  }

  const paths = (advisory.findings || []).flatMap((finding) => finding.paths || [])
  if (
    paths.length === 0 ||
    paths.some(
      (dependencyPath) =>
        !waiver.allowedPathPrefixes.some((prefix) => dependencyPath.startsWith(prefix)),
    )
  ) {
    return 'dependency path escaped the documented scope'
  }

  if (
    waiver.requiredPathMarkers &&
    paths.some(
      (dependencyPath) =>
        !waiver.requiredPathMarkers.some((marker) => dependencyPath.includes(marker)),
    )
  ) {
    return 'dependency path is no longer confined to the documented non-runtime tooling'
  }

  if (waiver.sourceRoot && waiver.sourceAbsenceMarkers) {
    const sourceRoot = path.join(workspaceRoot, waiver.sourceRoot)
    const source = listSourceFiles(sourceRoot)
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n')
    const detectedMarker = waiver.sourceAbsenceMarkers.find((marker) => source.includes(marker))
    if (detectedMarker) {
      return `excluded feature marker is now present: ${detectedMarker}`
    }
  }

  return null
}

const advisories = Object.values(report.advisories || {})
const gatedSeverities = new Set(['moderate', 'high', 'critical'])
const actionable = []
const acceptedWaivers = []

for (const advisory of advisories) {
  if (!gatedSeverities.has(advisory.severity)) {
    continue
  }

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
  console.warn(
    `WAIVED until ${waiver.expires}: ${advisory.github_advisory_id} ` +
      `(${advisory.module_name}) — ${waiver.reason}`,
  )
}

if (actionable.length === 0) {
  console.log(
    `Workspace production audit passed: ${advisories.length - acceptedWaivers.length} ` +
      `actionable advisories, ${acceptedWaivers.length} narrowly scoped waiver(s).`,
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
