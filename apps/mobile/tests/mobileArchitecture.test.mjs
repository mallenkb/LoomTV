import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('AppRoot coordinates domain controllers and keeps composition hooks bounded', async () => {
  const sourceText = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const sourceFile = ts.createSourceFile('App.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let appRoot;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'AppRoot') appRoot = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(appRoot?.body, 'AppRoot must remain present');
  const rootText = appRoot.getText(sourceFile);
  for (const controller of [
    'useMobileConnectionSessionController',
    'useMobileNavigationController',
    'useMobilePlaybackController',
  ]) assert.match(rootText, new RegExp(`\\b${controller}\\s*\\(`));
  assert.doesNotMatch(rootText, /\buseVideoPlayer\s*\(/, 'the native player belongs in the playback controller');
  const hookCalls = [...rootText.matchAll(/\buse(?:State|Ref|Effect|Memo|Callback)\s*\(/g)].length;
  assert.ok(hookCalls <= 55, `AppRoot composition hook budget exceeded: ${hookCalls}`);
});
