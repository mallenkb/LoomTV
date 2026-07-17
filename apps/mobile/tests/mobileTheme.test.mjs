import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOBILE_THEME, mobileThemeFromSettings } from '../mobileTheme.ts';

test('default mobile theme remains the cinematic yellow dark theme', () => {
  assert.deepEqual(mobileThemeFromSettings(), DEFAULT_MOBILE_THEME);
  assert.equal(DEFAULT_MOBILE_THEME.themeLabel, 'Cinematic');
  assert.equal(DEFAULT_MOBILE_THEME.text, '#ffffff');
});

test('remote accent and dark-theme settings retain their existing color mapping', () => {
  const theme = mobileThemeFromSettings({ appThemeColor: 'blue', appDarkTheme: 'justwatch' }, 'dark');

  assert.equal(theme.accent, '#8FB8FF');
  assert.equal(theme.bg, '#060d17');
  assert.equal(theme.themeLabel, 'Navy Black');
  assert.equal(theme.text, '#ffffff');
});

test('light mode keeps black text and the yellow contrast override', () => {
  const theme = mobileThemeFromSettings({ appThemeColor: 'yellow', appDarkTheme: 'black' }, 'light');

  assert.equal(theme.bg, '#f4f6f8');
  assert.equal(theme.text, '#000000');
  assert.equal(theme.accentForeground, '#000000');
  assert.equal(theme.themeLabel, 'Light');
});

test('unknown remote theme values fall back to the default palette', () => {
  assert.deepEqual(
    mobileThemeFromSettings({ appThemeColor: 'unknown', appDarkTheme: 'unknown' }, 'dark'),
    DEFAULT_MOBILE_THEME,
  );
});
