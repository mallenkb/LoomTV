import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import {
  AppThemeSettings,
  DEFAULT_THEME_SETTINGS,
  applyTheme,
  normalizeDarkTheme,
  normalizeLoaderStyle,
  normalizeThemeColor,
} from '@/lib/theme';

const THEME_CACHE_KEY = 'loomtv:theme-settings';

type ThemeContextValue = {
  theme: AppThemeSettings;
  setTheme: (settings: Partial<AppThemeSettings>) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function normalizeThemeSettings(settings: Partial<AppThemeSettings> = {}): AppThemeSettings {
  return {
    mode: 'dark',
    color: normalizeThemeColor(settings.color),
    darkTheme: normalizeDarkTheme(settings.darkTheme),
    loaderStyle: normalizeLoaderStyle(settings.loaderStyle),
  };
}

function readCachedTheme(): AppThemeSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const cachedTheme = window.localStorage.getItem(THEME_CACHE_KEY);
    return cachedTheme ? normalizeThemeSettings(JSON.parse(cachedTheme) as Partial<AppThemeSettings>) : null;
  } catch {
    return null;
  }
}

function writeCachedTheme(theme: AppThemeSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(theme));
  } catch {}
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<AppThemeSettings>(() => {
    const initialTheme = readCachedTheme() || DEFAULT_THEME_SETTINGS;
    applyTheme(initialTheme);
    return initialTheme;
  });

  useEffect(() => {
    let mounted = true;
    void desktopApi.getSettings()
      .then((settings) => {
        if (!mounted) return;
        const hasSavedTheme = Boolean(settings.appThemeColor || settings.appDarkTheme || settings.appLoaderStyle);
        const cachedTheme = readCachedTheme();
        const loadedTheme = hasSavedTheme
          ? normalizeThemeSettings({
              color: settings.appThemeColor,
              darkTheme: settings.appDarkTheme,
              loaderStyle: settings.appLoaderStyle,
            })
          : cachedTheme || DEFAULT_THEME_SETTINGS;
        setThemeState(loadedTheme);
        applyTheme(loadedTheme);
        writeCachedTheme(loadedTheme);
        if (!hasSavedTheme && cachedTheme) {
          void desktopApi.saveSettings({
            appThemeMode: loadedTheme.mode,
            appThemeColor: loadedTheme.color,
            appDarkTheme: loadedTheme.darkTheme,
            appLoaderStyle: loadedTheme.loaderStyle,
          });
        }
      })
      .catch(() => {
        const cachedTheme = readCachedTheme() || DEFAULT_THEME_SETTINGS;
        setThemeState(cachedTheme);
        applyTheme(cachedTheme);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = async (updates: Partial<AppThemeSettings>) => {
    const nextTheme = normalizeThemeSettings({ ...theme, ...updates });
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    writeCachedTheme(nextTheme);
    await desktopApi.saveSettings({
      appThemeMode: nextTheme.mode,
      appThemeColor: nextTheme.color,
      appDarkTheme: nextTheme.darkTheme,
      appLoaderStyle: nextTheme.loaderStyle,
    });
  };

  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: DEFAULT_THEME_SETTINGS,
      setTheme: async () => undefined,
    };
  }
  return context;
}
