const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

test('Expo CLI plugin and MCP schemas work with the fixed Zod resolution', () => {
  const cliRequire = createRequire(require.resolve('@expo/cli/package.json'))
  const { PluginSchema, DevToolsPluginOutputSchema } = cliRequire('./build/src/start/server/DevToolsPlugin.schema.js')
  const { createMCPDevToolsExtensionSchema } = cliRequire('./build/src/start/server/createMCPDevToolsExtensionSchema.js')
  const plugin = {
    packageName: 'fixture-tools', packageRoot: '/fixture',
    cliExtensions: {
      description: 'Fixture commands', entryPoint: 'cli.js', commands: [{
        name: 'inspect', title: 'Inspect', environments: ['cli', 'mcp'],
        parameters: [{ name: 'limit', type: 'number' }, { name: 'confirm', type: 'confirm' }, { name: 'query', type: 'text' }],
      }],
    },
  }
  assert.equal(PluginSchema.safeParse(plugin).success, true)
  assert.equal(PluginSchema.safeParse({ ...plugin, packageName: '' }).success, false)
  assert.equal(DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 'Ready', level: 'info' }]).success, true)
  assert.equal(DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 1, level: 'info' }]).success, false)
  const schema = createMCPDevToolsExtensionSchema(plugin)
  const command = { command: 'inspect', limit: 2, confirm: true, query: 'fixture' }
  assert.deepEqual(schema.parse(command), command)
  assert.equal(schema.safeParse({ command: 'unknown' }).success, false)
  assert.equal(schema.safeParse({ ...command, limit: 'two' }).success, false)
  assert.equal(schema.safeParse({ ...command, unexpected: true }).success, false)
})

test('Expo CLI rejects oversized bounded collections before walking their elements', () => {
  const cliRequire = createRequire(require.resolve('@expo/cli/package.json'))
  const { z } = cliRequire('zod')
  let parsed = 0
  const schema = z.array(z.preprocess(value => { parsed += 1; return value }, z.string())).max(2)
  assert.equal(schema.safeParse(['a', 'b', 'c', 'd']).success, false)
  assert.equal(parsed, 0)
})

// Resolve the actual package used by each production-listed mobile build tool.
// Missing or unapplied patches must fail CI instead of silently keeping a waiver.
const workspaceRoot = path.resolve(__dirname, '..')
function toolingDependencies(workspace) {
  const app = createRequire(path.join(workspaceRoot, 'apps', workspace, 'package.json'))
  const metro = createRequire(app.resolve('metro-file-map/package.json'))
  const micromatchPath = metro.resolve('micromatch/package.json')
  const micromatch = createRequire(micromatchPath)
  return { braces: micromatch('braces'), micromatch: metro('micromatch') }
}

function nestedAst(depth) {
  let node = { type: 'text', value: 'a' }
  for (let index = 0; index < depth; index += 1) {
    const parent = { type: 'paren', nodes: [node] }
    node.parent = parent
    node = parent
  }
  const root = { type: 'root', nodes: [node] }
  node.parent = root
  return root
}

for (const workspace of ['mobile', 'tv']) {
  const { braces, micromatch } = toolingDependencies(workspace)
  test(`${workspace}: ordinary glob patterns retain their behavior`, () => {
    assert.equal(braces.compile('src/{main,renderer}/file.{js,ts}'), 'src/(main|renderer)/file.(js|ts)')
    assert.deepEqual(braces.expand('episode-{01..03}.{mkv,mp4}'), [
      'episode-01.mkv', 'episode-01.mp4', 'episode-02.mkv', 'episode-02.mp4', 'episode-03.mkv', 'episode-03.mp4',
    ])
    assert.equal(braces.stringify(braces.parse('src/{a,b}/*.js')), 'src/{a,b}/*.js')
    assert.deepEqual(micromatch(['src/main/a.ts', 'src/renderer/b.ts', 'other/c.ts'], 'src/{main,renderer}/*.ts'), ['src/main/a.ts', 'src/renderer/b.ts'])
    assert.equal(braces.compile('('.repeat(64) + 'a' + ')'.repeat(64)), '('.repeat(64) + 'a' + ')'.repeat(64))
    assert.equal(braces.stringify(braces.parse('\\{'.repeat(200) + 'a')), '{'.repeat(200) + 'a')
  })
  test(`${workspace}: recursive entry points reject excessive string nesting`, () => {
    const patterns = [
      '{'.repeat(4000) + 'a' + '}'.repeat(4000),
      '{'.repeat(4000) + 'a',
      '('.repeat(4000) + 'a' + ')'.repeat(4000),
      '{('.repeat(2000) + 'a' + ')}'.repeat(2000),
      '${'.repeat(2000) + 'a' + '}'.repeat(2000),
    ]
    for (const pattern of patterns) {
      for (const method of ['parse', 'compile', 'expand', 'stringify', 'create']) {
        assert.throws(() => braces[method](pattern, { maxLength: Infinity }), {
          name: 'SyntaxError', message: 'Brace pattern exceeds maximum nesting depth',
        }, `${method} must reject deep nesting before exhausting the stack`)
      }
      assert.throws(() => braces(pattern), /maximum nesting depth/)
    }
  })
  test(`${workspace}: caller-supplied ASTs cannot bypass depth limits`, () => {
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](nestedAst(4000)), {
        name: 'SyntaxError', message: 'Brace pattern exceeds maximum nesting depth',
      })
    }
    assert.equal(braces.compile(nestedAst(64)), 'a')
    assert.equal(braces.stringify(nestedAst(64)), 'a')
    assert.deepEqual(braces.expand(nestedAst(64)), ['a'])
  })
}

test('bittorrent-tracker formats UDP announce addresses without vulnerable ip helpers', async () => {
  const trackerRoot = path.join(workspaceRoot, 'node_modules', 'bittorrent-tracker')
  const trackerPackage = JSON.parse(fs.readFileSync(path.join(trackerRoot, 'package.json'), 'utf8'))
  assert.equal(trackerPackage.dependencies.ip, undefined)

  const [{ default: parseUdpRequest }, { default: common }] = await Promise.all([
    import(pathToFileURL(path.join(trackerRoot, 'lib/server/parse-udp.js')).href),
    import(pathToFileURL(path.join(trackerRoot, 'lib/common.js')).href),
  ])
  const message = Buffer.alloc(98)
  Buffer.from(common.CONNECTION_ID).copy(message)
  message.writeUInt32BE(common.ACTIONS.ANNOUNCE, 8)
  message.writeUInt32BE(1, 12)
  Buffer.alloc(20, 0x61).copy(message, 16)
  Buffer.alloc(20, 0x62).copy(message, 36)
  message.writeUInt32BE(common.EVENTS.started, 80)
  message.writeUInt32BE(0x7f000001, 84)
  message.writeUInt16BE(6881, 96)

  const result = parseUdpRequest(message, { address: '192.0.2.10', port: 51413 })
  assert.equal(result.ip, '127.0.0.1')
  assert.equal(result.addr, '127.0.0.1:6881')
})
