import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import { useProfiles } from '@/contexts/ProfileContext';
import {
  AppThemeSettings,
  DEFAULT_THEME_SETTINGS,
  applyTheme,
  normalizeThemeSettings,
  readCachedTheme,
  writeCachedTheme,
} from '@/lib/theme';

type ThemeContextValue = {
  theme: AppThemeSettings;
  setTheme: (settings: Partial<AppThemeSettings>) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

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
          appHomeStyle: preferences.appHomeStyle,
        };
        const hasSavedTheme = Boolean(profileTheme.appThemeMode || profileTheme.appThemeColor || profileTheme.appDarkTheme || profileTheme.appLoaderStyle || profileTheme.appHomeStyle || settings.appThemeMode || settings.appThemeColor || settings.appDarkTheme || settings.appLoaderStyle);
        const cachedTheme = readCachedTheme();
        const loadedTheme = hasSavedTheme
          ? normalizeThemeSettings({
              mode: profileTheme.appThemeMode ?? settings.appThemeMode,
              color: profileTheme.appThemeColor ?? settings.appThemeColor,
              darkTheme: profileTheme.appDarkTheme ?? settings.appDarkTheme,
              loaderStyle: profileTheme.appLoaderStyle ?? settings.appLoaderStyle,
              homeStyle: profileTheme.appHomeStyle ?? cachedTheme?.homeStyle,
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
            appHomeStyle: loadedTheme.homeStyle,
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
      appHomeStyle: nextTheme.homeStyle,
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
