const { spawnSync } = require('node:child_process')

const audit = spawnSync('corepack', ['pnpm', 'audit', '--prod', '--json'], {
  cwd: process.cwd(),
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

const advisories = Object.values(report.advisories || {})
const ignoredDesktopAdvisories = new Set([
  // LoomTV is a client-side Electron app and does not enable React Server
  // Components or RSC action endpoints covered by this advisory.
  'GHSA-qwww-vcr4-c8h2',
])
const desktopAdvisories = advisories.filter((advisory) =>
  !ignoredDesktopAdvisories.has(advisory.github_advisory_id) &&
  (advisory.findings || []).some((finding) =>
    (finding.paths || []).some((dependencyPath) => dependencyPath.startsWith('apps__desktop>')),
  ),
)

if (desktopAdvisories.length === 0) {
  console.log(
    `Desktop production audit passed (${advisories.length} unrelated or scoped advisories excluded).`,
  )
  process.exit(0)
}

for (const advisory of desktopAdvisories) {
  console.error(`${advisory.severity}: ${advisory.module_name} - ${advisory.title}`)
}

console.error(`Desktop production audit failed with ${desktopAdvisories.length} advisory(s).`)
process.exit(1)
