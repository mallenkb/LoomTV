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
  showProviderRatingBadges: boolean;
  setShowProviderRatingBadges: (show: boolean) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeProfile } = useProfiles();
  const [theme, setThemeState] = useState<AppThemeSettings>(() => {
    const initialTheme = readCachedTheme() || DEFAULT_THEME_SETTINGS;
    applyTheme(initialTheme);
    return initialTheme;
  });
  const [showProviderRatingBadges, setShowProviderRatingBadgesState] = useState(true);

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
          appModernHeroMode: preferences.appModernHeroMode,
        };
        const hasSavedTheme = Boolean(profileTheme.appThemeMode || profileTheme.appThemeColor || profileTheme.appDarkTheme || profileTheme.appLoaderStyle || profileTheme.appHomeStyle || profileTheme.appModernHeroMode || settings.appThemeMode || settings.appThemeColor || settings.appDarkTheme || settings.appLoaderStyle);
        const cachedTheme = readCachedTheme();
        const loadedTheme = hasSavedTheme
          ? normalizeThemeSettings({
              mode: profileTheme.appThemeMode ?? settings.appThemeMode,
              color: profileTheme.appThemeColor ?? settings.appThemeColor,
              darkTheme: profileTheme.appDarkTheme ?? settings.appDarkTheme,
              loaderStyle: profileTheme.appLoaderStyle ?? settings.appLoaderStyle,
              homeStyle: profileTheme.appHomeStyle ?? cachedTheme?.homeStyle,
              modernHeroMode: profileTheme.appModernHeroMode ?? cachedTheme?.modernHeroMode,
            })
          : cachedTheme || DEFAULT_THEME_SETTINGS;
        setThemeState(loadedTheme);
        setShowProviderRatingBadgesState(preferences.showProviderRatingBadges ?? true);
        applyTheme(loadedTheme);
        writeCachedTheme(loadedTheme);
        if (!hasSavedTheme && cachedTheme) {
          void desktopApi.saveProfilePreferences({
            appThemeMode: loadedTheme.mode,
            appThemeColor: loadedTheme.color,
            appDarkTheme: loadedTheme.darkTheme,
            appLoaderStyle: loadedTheme.loaderStyle,
            appHomeStyle: loadedTheme.homeStyle,
            appModernHeroMode: loadedTheme.modernHeroMode,
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
      appModernHeroMode: nextTheme.modernHeroMode,
    }, activeProfile?.id);
  }, [activeProfile?.id, theme]);

  const setShowProviderRatingBadges = useCallback(async (show: boolean) => {
    setShowProviderRatingBadgesState(show);
    await desktopApi.saveProfilePreferences({ showProviderRatingBadges: show }, activeProfile?.id);
  }, [activeProfile?.id]);

  const value = useMemo(() => ({
    theme,
    setTheme,
    showProviderRatingBadges,
    setShowProviderRatingBadges,
  }), [setShowProviderRatingBadges, setTheme, showProviderRatingBadges, theme]);

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
      showProviderRatingBadges: true,
      setShowProviderRatingBadges: async () => undefined,
    };
  }
  return context;
}
