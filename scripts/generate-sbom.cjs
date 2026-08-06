const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')

const workspaceRoot = path.resolve(__dirname, '..')
const lockfilePath = path.join(workspaceRoot, 'pnpm-lock.yaml')
const outputPath = path.resolve(
  workspaceRoot,
  process.argv[2] || path.join('artifacts', 'loomtv-sbom.cdx.json'),
)
const lockfileSource = fs.readFileSync(lockfilePath, 'utf8')
const lockfile = YAML.parse(lockfileSource)
const runtimeManifestPath = path.join(
  workspaceRoot,
  'apps/desktop/resources/ffmpeg/runtime-provenance.json',
)
if (!fs.existsSync(runtimeManifestPath)) {
  throw new Error(`Missing native runtime provenance manifest: ${runtimeManifestPath}`)
}

const runtimeManifestSource = fs.readFileSync(runtimeManifestPath, 'utf8')
let runtimeManifest
try {
  runtimeManifest = JSON.parse(runtimeManifestSource)
} catch (error) {
  throw new Error(`Invalid native runtime provenance manifest ${runtimeManifestPath}: ${String(error)}`)
}
if (
  runtimeManifest.manifestVersion !== 1
  || runtimeManifest.application?.license !== 'MIT'
  || runtimeManifest.pathsAreRelativeTo !== 'resources'
  || runtimeManifest.distributionPolicy?.mpvBundled !== false
  || runtimeManifest.distributionPolicy?.mpvDownloadedByLoomTV !== false
  || runtimeManifest.distributionPolicy?.mpvLinkedByLoomTV !== false
  || !Array.isArray(runtimeManifest.components)
  || runtimeManifest.components.length === 0
) {
  throw new Error(`Native runtime provenance manifest is missing required fields: ${runtimeManifestPath}`)
}

const retiredRuntimePackages = new Set(['ffmpeg-static', 'ffprobe-static'])

function parsePackageLocator(locator) {
  const peerSuffix = locator.indexOf('(')
  const base = peerSuffix === -1 ? locator : locator.slice(0, peerSuffix)
  const versionSeparator = base.lastIndexOf('@')
  if (versionSeparator <= 0) return null

  const name = base.slice(0, versionSeparator)
  const version = base.slice(versionSeparator + 1)
  if (!name || !version || version.includes(':')) return null
  return { name, version }
}

function toPackageUrl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function integrityHashes(resolution) {
  const integrity = resolution && resolution.integrity
  const match = typeof integrity === 'string' && integrity.match(/^sha(256|384|512)-(.+)$/)
  if (!match) return undefined

  return [
    {
      alg: `SHA-${match[1]}`,
      content: Buffer.from(match[2], 'base64').toString('hex'),
    },
  ]
}

function packageManifest(name) {
  const manifestPath = path.join(workspaceRoot, 'node_modules', ...name.split('/'), 'package.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function licenseEntries(manifest) {
  if (!manifest) return [{ license: { id: 'NOASSERTION' } }]
  if (typeof manifest.license === 'string' && manifest.license.trim()) {
    return [{ license: { id: manifest.license.trim() } }]
  }
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses.map((entry) => ({
      license: typeof entry === 'string' ? { id: entry } : {
        id: entry?.type || entry?.name || 'NOASSERTION',
        ...(entry?.url ? { url: entry.url } : {}),
      },
    }))
  }
  return [{ license: { id: 'NOASSERTION' } }]
}

const componentsByRef = new Map()
for (const [locator, packageRecord] of Object.entries(lockfile.packages || {})) {
  const parsed = parsePackageLocator(locator)
  if (!parsed) continue
  if (retiredRuntimePackages.has(parsed.name)) continue

  const purl = toPackageUrl(parsed.name, parsed.version)
  const manifest = packageManifest(parsed.name)
  const component = {
    type: 'library',
    'bom-ref': purl,
    name: parsed.name,
    version: parsed.version,
    purl,
    licenses: licenseEntries(manifest),
  }
  const hashes = integrityHashes(packageRecord.resolution)
  if (hashes) component.hashes = hashes
  componentsByRef.set(purl, component)
}

function nativeRuntimeComponent(component) {
  const bomRef = `urn:loomtv:native-runtime:${component.id}`
  const properties = [
    { name: 'loomtv:native-runtime', value: 'true' },
    ...(component.noticeFile
      ? [{ name: 'loomtv:notice-file', value: component.noticeFile }]
      : []),
    ...(component.licenseFile
      ? [{ name: 'loomtv:license-file', value: component.licenseFile }]
      : []),
    ...(component.files || []).flatMap((file) => [
      { name: 'loomtv:runtime-file', value: file.path },
      { name: 'loomtv:runtime-file-sha256', value: file.sha256 || 'not-recorded-in-current-notice' },
      { name: 'loomtv:runtime-file-hash-status', value: file.hashStatus || 'unspecified' },
    ]),
    ...(component.thirdPartyComponents
      ? [{ name: 'loomtv:third-party-components', value: component.thirdPartyComponents }]
      : []),
  ]

  const externalReferences = []
  for (const provenance of component.provenance || []) {
    if (provenance.url) {
      externalReferences.push({ type: 'website', url: provenance.url })
    }
    for (const url of provenance.archiveUrls || []) {
      externalReferences.push({ type: 'distribution', url })
    }
    if (provenance.licenseInventory) {
      externalReferences.push({ type: 'other', url: provenance.licenseInventory })
    }
    for (const revisionKey of ['revision', 'buildVersion']) {
      if (provenance[revisionKey]) {
        properties.push({
          name: `loomtv:provenance-${revisionKey}`,
          value: `${provenance.platform || 'all'}=${provenance[revisionKey]}`,
        })
      }
    }
    if (provenance.provider) {
      properties.push({
        name: 'loomtv:provenance-provider',
        value: `${provenance.platform || 'all'}=${provenance.provider}`,
      })
    }
    if (provenance.configure) {
      properties.push({
        name: 'loomtv:provenance-configure',
        value: provenance.configure,
      })
    }
  }

  const hashes = (component.files || [])
    .filter((file) => typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256))
    .map((file) => ({ alg: 'SHA-256', content: file.sha256 }))

  return {
    type: 'application',
    'bom-ref': bomRef,
    name: component.name,
    ...(component.version ? { version: component.version } : {}),
    licenses: component.license ? [{ license: { id: component.license } }] : undefined,
    ...(hashes.length > 0 ? { hashes } : {}),
    ...(externalReferences.length > 0 ? { externalReferences } : {}),
    properties,
  }
}

for (const nativeComponent of runtimeManifest.components) {
  const component = nativeRuntimeComponent(nativeComponent)
  componentsByRef.set(component['bom-ref'], component)
}

for (const importerPath of Object.keys(lockfile.importers || {})) {
  if (importerPath === '.') continue

  const manifestPath = path.join(workspaceRoot, importerPath, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const version = manifest.version || '0.0.0-workspace'
  const purl = toPackageUrl(manifest.name, version)
  componentsByRef.set(purl, {
    type: importerPath.startsWith('apps/') ? 'application' : 'library',
    'bom-ref': purl,
    name: manifest.name,
    version,
    purl,
    licenses: licenseEntries(manifest),
    properties: [{ name: 'loomtv:workspace-importer', value: importerPath }],
  })
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'))
const lockfileSha256 = crypto.createHash('sha256').update(lockfileSource).digest('hex')
const runtimeManifestSha256 = crypto.createHash('sha256').update(runtimeManifestSource).digest('hex')
const sbom = {
  $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': 'urn:loomtv:workspace',
      name: rootManifest.name,
      version: rootManifest.version || '0.0.0-workspace',
    },
    tools: {
      components: [
        {
          type: 'application',
          name: 'LoomTV deterministic pnpm SBOM generator',
          version: '1',
        },
      ],
    },
    properties: [
      { name: 'loomtv:source-lockfile', value: 'pnpm-lock.yaml' },
      { name: 'loomtv:source-lockfile-sha256', value: lockfileSha256 },
      { name: 'loomtv:native-runtime-manifest', value: 'apps/desktop/resources/ffmpeg/runtime-provenance.json' },
      { name: 'loomtv:native-runtime-manifest-sha256', value: runtimeManifestSha256 },
      { name: 'loomtv:retired-runtime-packages', value: [...retiredRuntimePackages].join(',') },
    ],
  },
  components: [...componentsByRef.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  ),
}

sbom.dependencies = [{
  ref: 'urn:loomtv:workspace',
  dependsOn: sbom.components.map((component) => component['bom-ref']),
}]

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`)
console.log(`Wrote ${sbom.components.length} components to ${outputPath}`)
