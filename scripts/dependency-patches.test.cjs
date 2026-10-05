const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const path = require('node:path')

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
