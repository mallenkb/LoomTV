import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function findNamedFunction(sourceFile, name) {
  let match;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return match;
}

test('AppRoot coordinates domain controllers and keeps composition hooks bounded', async () => {
  const sourceText = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const sourceFile = ts.createSourceFile('App.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const appRoot = findNamedFunction(sourceFile, 'AppRoot');
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

test('pairing preserves its large-text reflow and keyboard-safe scrolling contract', async () => {
  const [appSourceText, stylesText] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../mobileStyles.ts', import.meta.url), 'utf8'),
  ]);
  const sourceFile = ts.createSourceFile('App.tsx', appSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pairingScreen = findNamedFunction(sourceFile, 'PairingScreen');
  assert.ok(pairingScreen?.body, 'PairingScreen must remain present');
  const pairingText = pairingScreen.getText(sourceFile);

  assert.match(pairingText, /const usesLargeTextLayout = fontScale >= 1\.5;/);
  assert.equal([...pairingText.matchAll(/<ScrollView\b/g)].length, 1, 'pairing must remain one scrollable task');
  assert.match(pairingText, /<KeyboardAvoidingView\b/);
  assert.match(pairingText, /automaticallyAdjustKeyboardInsets=/);
  assert.match(pairingText, /contentInsetAdjustmentBehavior="automatic"/);
  assert.match(pairingText, /usesLargeTextLayout && styles\.pairingContentLargeText/);
  assert.match(pairingText, /usesLargeTextLayout && styles\.hostCardLargeText/);
  assert.match(pairingText, /<Text selectable style=\{styles\.hostName\}>\{host\.deviceName\}<\/Text>/);
  assert.doesNotMatch(pairingText, /numberOfLines=/, 'pairing copy must remain free to wrap');

  assert.match(stylesText, /pairingContent:\s*\{[^}]*flexGrow:\s*1[^}]*\}/s);
  assert.match(stylesText, /pairingContentLargeText:\s*\{[^}]*justifyContent:\s*'flex-start'[^}]*\}/s);
  assert.match(stylesText, /hostCardLargeText:\s*\{[^}]*alignItems:\s*'flex-start'[^}]*flexDirection:\s*'column'[^}]*\}/s);
});

test('tab navigation stays independent from request cancellation and health aborts stay neutral', async () => {
  const [appSourceText, navigationText] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../useMobileNavigationController.ts', import.meta.url), 'utf8'),
  ]);
  const sourceFile = ts.createSourceFile('App.tsx', appSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const appRoot = findNamedFunction(sourceFile, 'AppRoot');
  const healthCheck = findNamedFunction(sourceFile, 'checkDesktopConnection');
  assert.ok(appRoot?.body, 'AppRoot must remain present');
  assert.ok(healthCheck?.body, 'checkDesktopConnection must remain present');

  assert.match(appRoot.getText(sourceFile), /useMobileNavigationController\(\)/);
  assert.doesNotMatch(navigationText, /cancelActiveRequests/, 'tab navigation must not own request cancellation');

  const healthText = healthCheck.getText(sourceFile);
  const classificationIndex = healthText.indexOf("connectionErrorFor(nextError, MOBILE_ONBOARDING_OFFLINE_MESSAGE, 'MOBILE-HEALTH')");
  assert.ok(classificationIndex >= 0, 'health failures must use the mobile health classification');
  const failurePath = healthText.slice(classificationIndex);
  const cancelledReturnIndex = failurePath.indexOf('if (connectionError.isCancelled) return;');
  assert.ok(cancelledReturnIndex >= 0, 'cancelled health requests must return immediately');
  for (const stateChange of ['reportNonFatal(', 'restoreOfflineConnection(', 'setIsServerOffline(', 'setError(']) {
    const stateChangeIndex = failurePath.indexOf(stateChange);
    assert.ok(stateChangeIndex > cancelledReturnIndex, `${stateChange} must remain after the cancellation return`);
  }
});
