import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { desktopApi } from '@/lib/desktopApi';
import {
  AppThemeSettings,
  DEFAULT_THEME_SETTINGS,
  applyTheme,
  normalizeLoaderStyle,
  normalizeThemeColor,
} from '@/lib/theme';

type ThemeContextValue = {
  theme: AppThemeSettings;
  setTheme: (settings: Partial<AppThemeSettings>) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<AppThemeSettings>(DEFAULT_THEME_SETTINGS);

  useEffect(() => {
    let mounted = true;
    void desktopApi.getSettings()
      .then((settings) => {
        if (!mounted) return;
        const loadedTheme = {
          mode: 'dark' as const,
          color: normalizeThemeColor(settings.appThemeColor),
          loaderStyle: normalizeLoaderStyle(settings.appLoaderStyle),
        };
        setThemeState(loadedTheme);
        applyTheme(loadedTheme);
      })
      .catch(() => applyTheme(DEFAULT_THEME_SETTINGS));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = async (updates: Partial<AppThemeSettings>) => {
    const nextTheme = {
      mode: 'dark' as const,
      color: normalizeThemeColor(updates.color || theme.color),
      loaderStyle: normalizeLoaderStyle(updates.loaderStyle || theme.loaderStyle),
    };
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    await desktopApi.saveSettings({
      appThemeMode: nextTheme.mode,
      appThemeColor: nextTheme.color,
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
