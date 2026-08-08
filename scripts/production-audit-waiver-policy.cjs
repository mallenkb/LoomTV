function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
}

function plainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalDependencyPath(value) {
  if (!nonEmptyString(value)) {
    return null
  }

  const segments = value.split('>')
  if (
    segments.length < 2 ||
    segments.some((segment) => !nonEmptyString(segment) || segment !== segment.trim())
  ) {
    return null
  }

  return { raw: value, segments }
}

function advisoryPaths(advisory) {
  if (!advisory || !Array.isArray(advisory.findings) || advisory.findings.length === 0) {
    return null
  }

  const paths = []
  for (const finding of advisory.findings) {
    if (!finding || !Array.isArray(finding.paths) || finding.paths.length === 0) {
      return null
    }

    for (const dependencyPath of finding.paths) {
      const canonicalPath = canonicalDependencyPath(dependencyPath)
      if (!canonicalPath) {
        return null
      }
      paths.push(canonicalPath)
    }
  }

  return paths
}

function parsePathPrefix(value) {
  if (!nonEmptyString(value) || !value.endsWith('>')) {
    return null
  }

  return canonicalDependencyPath(`${value.slice(0, -1)}>__scope_end__`)?.segments.slice(0, -1) || null
}

function parsePathMarker(value) {
  if (!nonEmptyString(value) || !value.startsWith('>') || value.endsWith('>')) {
    return null
  }

  return canonicalDependencyPath(`__scope_start__${value}`)?.segments.slice(1) || null
}

function startsWithSegments(pathSegments, prefixSegments) {
  return prefixSegments.every((segment, index) => pathSegments[index] === segment)
}

function containsSegments(pathSegments, markerSegments) {
  const lastStart = pathSegments.length - markerSegments.length
  for (let start = 0; start <= lastStart; start += 1) {
    if (markerSegments.every((segment, index) => pathSegments[start + index] === segment)) {
      return true
    }
  }
  return false
}

function utcDateEnd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    return null
  }

  const timestamp = Date.parse(`${value}T23:59:59.999Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null
  }
  return timestamp
}

function utcDateStart(value) {
  const end = utcDateEnd(value)
  return end === null ? null : end - (24 * 60 * 60 * 1000 - 1)
}

function validateAuditInvocation(status, signal) {
  if (signal) {
    return `pnpm audit was terminated by signal ${signal}`
  }
  if (!Number.isInteger(status) || ![0, 1].includes(status)) {
    return `pnpm audit exited with unexpected status ${status}`
  }
  return null
}

function validateAuditReport(report) {
  if (!plainRecord(report) || !plainRecord(report.advisories)) {
    return 'pnpm audit returned invalid advisory metadata'
  }

  const knownSeverities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
  const advisoryIds = new Set()
  for (const [reportKey, advisory] of Object.entries(report.advisories)) {
    if (
      !plainRecord(advisory) ||
      !nonEmptyString(advisory.github_advisory_id) ||
      advisoryIds.has(advisory.github_advisory_id) ||
      !nonEmptyString(advisory.module_name) ||
      !knownSeverities.has(advisory.severity)
    ) {
      return `pnpm audit returned invalid metadata for advisory ${reportKey}`
    }
    advisoryIds.add(advisory.github_advisory_id)
  }

  return null
}

function orphanedWaiverIds(advisories, waivers) {
  const reportedAdvisoryIds = new Set(
    advisories.map((advisory) => advisory.github_advisory_id),
  )
  return Object.keys(waivers).filter((advisoryId) => !reportedAdvisoryIds.has(advisoryId))
}

function validateWaiver(advisory, waiver, now = new Date()) {
  if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
    return 'waiver is not an object'
  }

  if (!nonEmptyString(waiver.module)) {
    return 'waiver module is missing'
  }

  if (waiver.module !== advisory.module_name) {
    return `module changed from ${waiver.module} to ${advisory.module_name}`
  }

  const expiry = utcDateEnd(waiver.expires)
  if (expiry === null) {
    return 'waiver expiry must use YYYY-MM-DD'
  }

  const reviewedOn = utcDateStart(waiver.reviewedOn)
  if (reviewedOn === null) {
    return 'waiver review date must use YYYY-MM-DD'
  }

  const ninetyDays = 90 * 24 * 60 * 60 * 1000
  const expiryDay = expiry - (24 * 60 * 60 * 1000 - 1)
  if (expiryDay - reviewedOn > ninetyDays || reviewedOn > expiryDay) {
    return 'waiver validity must be between 1 and 90 days'
  }

  const evaluatedAt = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(evaluatedAt)) {
    return 'waiver evaluation time is invalid'
  }
  if (evaluatedAt < reviewedOn) {
    return `waiver review date ${waiver.reviewedOn} is in the future`
  }
  if (evaluatedAt > expiry) {
    return `waiver expired on ${waiver.expires}`
  }

  if (!nonEmptyString(waiver.owner)) {
    return 'waiver owner is missing'
  }

  if (!nonEmptyString(waiver.reason)) {
    return 'waiver reason is missing'
  }

  if (!nonEmptyStringArray(waiver.allowedPathPrefixes)) {
    return 'waiver must define at least one allowed dependency path prefix'
  }

  if (!nonEmptyStringArray(waiver.requiredPathMarkers)) {
    return 'waiver must define at least one required dependency path marker'
  }

  const allowedPathPrefixes = waiver.allowedPathPrefixes.map(parsePathPrefix)
  if (allowedPathPrefixes.some((prefix) => prefix === null)) {
    return 'waiver contains a malformed dependency path prefix'
  }

  const requiredPathMarkers = waiver.requiredPathMarkers.map(parsePathMarker)
  if (requiredPathMarkers.some((marker) => marker === null)) {
    return 'waiver contains a malformed dependency path marker'
  }

  const paths = advisoryPaths(advisory)
  if (!paths) {
    return 'advisory dependency paths are missing or malformed'
  }

  if (paths.some((dependencyPath) => dependencyPath.segments.at(-1) !== waiver.module)) {
    return 'dependency path does not terminate at the waived module'
  }

  if (paths.some((dependencyPath) =>
    !allowedPathPrefixes.some((prefix) => startsWithSegments(dependencyPath.segments, prefix)),
  )) {
    return 'dependency path escaped the documented scope'
  }

  if (paths.some((dependencyPath) =>
    requiredPathMarkers.some((marker) => !containsSegments(dependencyPath.segments, marker)),
  )) {
    return 'dependency path is missing a required scope marker'
  }

  return null
}

module.exports = {
  advisoryPaths,
  canonicalDependencyPath,
  orphanedWaiverIds,
  plainRecord,
  validateAuditInvocation,
  validateAuditReport,
  validateWaiver,
}
