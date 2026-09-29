import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return fs.readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('shared dialog contract provides a topmost stack, focus trap, restore, and inert underlay', () => {
  const dialog = source('components/ui/dialog.tsx');

  assert.match(dialog, /const modalLayers: ModalLayer\[\] = \[\];/);
  assert.match(dialog, /modalLayers\[modalLayers\.length - 1\]\?\.id === id/);
  assert.match(dialog, /document\.addEventListener\('keydown', handleKeyDown, true\)/);
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.match(dialog, /event\.stopPropagation\(\)/);
  assert.match(dialog, /restoreFocusAfterCommit\(previouslyFocused\)/);
  assert.match(dialog, /if \(active && !active\.contains\(target\)\) return/);
  assert.match(dialog, /inertElement\.inert = true/);
  assert.match(dialog, /sibling\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(dialog, /Do not clobber an accessibility state changed by the owner/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /aria-describedby=\{descriptionId\}/);
});

test('full-screen desktop layers opt into shared modal semantics', () => {
  const app = source('App.tsx');
  const profileGate = source('components/profiles/ProfileGate.tsx');
  const player = source('components/VideoPlayer.tsx');
  const modernHome = source('components/ModernHome.tsx');

  assert.match(app, /aria-hidden=\{appUnderlayHidden \? 'true' : undefined\}/);
  for (const layer of [profileGate, player, modernHome]) {
    assert.match(layer, /useModalLayer\(/);
    assert.match(layer, /role="dialog"/);
    assert.match(layer, /aria-modal="true"/);
    assert.match(layer, /data-modal-layer=/);
  }
  assert.match(profileGate, /onEscape: handleGateEscape/);
  assert.match(player, /data-modal-layer="video-player"/);
  assert.match(player, /data-modal-layer="playback-settings"/);
  assert.match(player, /data-modal-layer="episode-list"/);
  assert.match(player, /data-modal-layer="loom-player-error-title"|aria-labelledby="loom-player-error-title"/);
  assert.match(modernHome, /initialFocusRef: searchInputRef/);
});

test('settings and player dialogs expose descriptions for their accessible names', () => {
  const settingsProfiles = source('pages/ProfilesSettingsSection.tsx');
  const confirm = source('components/ConfirmProvider.tsx');
  const artwork = source('components/ArtworkEditorControls.tsx');
  const marker = source('components/VideoPlayer/PlayerMarkerEditor.tsx');

  assert.match(settingsProfiles, /DialogDescription/);
  assert.match(confirm, /DialogDescription/);
  assert.match(artwork, /DialogDescription/);
  assert.match(marker, /aria-describedby="loom-marker-editor-description"/);
  assert.match(marker, /dialogRef/);
});
