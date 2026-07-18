import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOBILE_THEME, mobileThemeFromSettings } from '../mobileTheme.ts';

test('default mobile theme matches the desktop Black theme', () => {
  assert.deepEqual(mobileThemeFromSettings(), DEFAULT_MOBILE_THEME);
  assert.equal(DEFAULT_MOBILE_THEME.themeLabel, 'Black');
  assert.equal(DEFAULT_MOBILE_THEME.text, '#fafafa');
});

test('remote theme settings only change the mobile accent palette', () => {
  const theme = mobileThemeFromSettings({ appThemeColor: 'blue', appDarkTheme: 'justwatch' }, 'dark');

  assert.equal(theme.accent, '#0367FC');
  assert.equal(theme.bg, DEFAULT_MOBILE_THEME.bg);
  assert.equal(theme.panel, DEFAULT_MOBILE_THEME.panel);
  assert.equal(theme.border, DEFAULT_MOBILE_THEME.border);
  assert.equal(theme.themeLabel, 'Black');
  assert.equal(theme.text, '#fafafa');
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
