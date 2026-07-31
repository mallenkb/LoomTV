import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';

const MobileReducedMotionContext = createContext<boolean | null>(null);

export function MobileReducedMotionProvider({ children }: { children: ReactNode }) {
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const updatePreference = (enabled: boolean) => {
      if (mounted) setReduceMotionEnabled(enabled);
    };
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', updatePreference);

    AccessibilityInfo.isReduceMotionEnabled()
      .then(updatePreference)
      .catch(() => updatePreference(false));

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  // Resolve the system preference before mounting animations so users who have
  // reduced motion enabled never see a brief animated first frame.
  if (reduceMotionEnabled === null) return null;

  return (
    <MobileReducedMotionContext.Provider value={reduceMotionEnabled}>
      {children}
    </MobileReducedMotionContext.Provider>
  );
}

export function useMobileReducedMotion(): boolean {
  const value = useContext(MobileReducedMotionContext);
  if (value === null) {
    throw new Error('useMobileReducedMotion must be used within MobileReducedMotionProvider');
  }
  return value;
}
