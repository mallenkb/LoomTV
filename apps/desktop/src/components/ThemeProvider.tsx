import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import { useProfiles } from '@/contexts/ProfileContext';
import {
  AppThemeSettings,
  DEFAULT_THEME_SETTINGS,
  applyTheme,
  normalizeDarkTheme,
  normalizeLoaderStyle,
  normalizeThemeMode,
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
    mode: normalizeThemeMode(settings.mode),
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
  const { activeProfile } = useProfiles();
  const [theme, setThemeState] = useState<AppThemeSettings>(() => {
    const initialTheme = readCachedTheme() || DEFAULT_THEME_SETTINGS;
    applyTheme(initialTheme);
    return initialTheme;
  });

  useEffect(() => {
    let mounted = true;
    const load = () => Promise.all([desktopApi.getSettings(), desktopApi.getProfilePreferences()])
      .then(([settings, preferences]) => {
        if (!mounted) return;
        const profileTheme = {
          appThemeMode: preferences.appThemeMode,
          appThemeColor: preferences.appThemeColor,
          appDarkTheme: preferences.appDarkTheme,
          appLoaderStyle: preferences.appLoaderStyle,
        };
        const hasSavedTheme = Boolean(profileTheme.appThemeMode || profileTheme.appThemeColor || profileTheme.appDarkTheme || profileTheme.appLoaderStyle || settings.appThemeMode || settings.appThemeColor || settings.appDarkTheme || settings.appLoaderStyle);
        const cachedTheme = readCachedTheme();
        const loadedTheme = hasSavedTheme
          ? normalizeThemeSettings({
              mode: profileTheme.appThemeMode ?? settings.appThemeMode,
              color: profileTheme.appThemeColor ?? settings.appThemeColor,
              darkTheme: profileTheme.appDarkTheme ?? settings.appDarkTheme,
              loaderStyle: profileTheme.appLoaderStyle ?? settings.appLoaderStyle,
            })
          : cachedTheme || DEFAULT_THEME_SETTINGS;
        setThemeState(loadedTheme);
        applyTheme(loadedTheme);
        writeCachedTheme(loadedTheme);
        if (!hasSavedTheme && cachedTheme) {
          void desktopApi.saveProfilePreferences({
            appThemeMode: loadedTheme.mode,
            appThemeColor: loadedTheme.color,
            appDarkTheme: loadedTheme.darkTheme,
            appLoaderStyle: loadedTheme.loaderStyle,
          }, activeProfile?.id);
        }
      })
      .catch(() => {
        const cachedTheme = readCachedTheme() || DEFAULT_THEME_SETTINGS;
        setThemeState(cachedTheme);
        applyTheme(cachedTheme);
      });
    void load();
    return () => {
      mounted = false;
    };
  }, [activeProfile?.id]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback(async (updates: Partial<AppThemeSettings>) => {
    const nextTheme = normalizeThemeSettings({ ...theme, ...updates });
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    writeCachedTheme(nextTheme);
    await desktopApi.saveProfilePreferences({
      appThemeMode: nextTheme.mode,
      appThemeColor: nextTheme.color,
      appDarkTheme: nextTheme.darkTheme,
      appLoaderStyle: nextTheme.loaderStyle,
    }, activeProfile?.id);
  }, [activeProfile?.id, theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

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
