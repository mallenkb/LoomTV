import { createContext, useContext, type ReactNode } from 'react';
import { createStyles, type MobileThemeColors } from './mobileStyles';

export type MobileThemeContextValue = {
  colors: MobileThemeColors;
  styles: ReturnType<typeof createStyles>;
};

const MobileThemeContext = createContext<MobileThemeContextValue | null>(null);

export function MobileThemeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: MobileThemeContextValue;
}) {
  return <MobileThemeContext.Provider value={value}>{children}</MobileThemeContext.Provider>;
}

export function useMobileTheme(): MobileThemeContextValue {
  const value = useContext(MobileThemeContext);
  if (!value) throw new Error('useMobileTheme must be used within MobileThemeProvider');
  return value;
}
