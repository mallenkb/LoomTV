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

const componentsByRef = new Map()
for (const [locator, packageRecord] of Object.entries(lockfile.packages || {})) {
  const parsed = parsePackageLocator(locator)
  if (!parsed) continue

  const purl = toPackageUrl(parsed.name, parsed.version)
  const component = {
    type: 'library',
    'bom-ref': purl,
    name: parsed.name,
    version: parsed.version,
    purl,
  }
  const hashes = integrityHashes(packageRecord.resolution)
  if (hashes) component.hashes = hashes
  componentsByRef.set(purl, component)
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
    properties: [{ name: 'loomtv:workspace-importer', value: importerPath }],
  })
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'))
const lockfileSha256 = crypto.createHash('sha256').update(lockfileSource).digest('hex')
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
    ],
  },
  components: [...componentsByRef.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  ),
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`)
console.log(`Wrote ${sbom.components.length} components to ${outputPath}`)
