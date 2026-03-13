'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

type Theme = 'light' | 'dark';
type ThemeSetting = Theme | 'system';

type ThemeContextValue = {
  themeSetting: ThemeSetting;
  resolvedTheme: Theme;
  systemTheme: Theme;
  isReady: boolean;
  setTheme: (next: ThemeSetting) => void;
  toggleTheme: () => void;
};

const STORAGE_KEY = 'theme-preference';

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>('system');
  const [systemTheme, setSystemTheme] = useState<Theme>('light');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const stored = window.localStorage.getItem(STORAGE_KEY) as ThemeSetting | null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setThemeSetting(stored);
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = (event?: MediaQueryListEvent) => {
      const prefersDark = event ? event.matches : media.matches;
      setSystemTheme(prefersDark ? 'dark' : 'light');
    };

    updateSystemTheme();
    media.addEventListener('change', updateSystemTheme);
    setIsReady(true);

    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  const resolvedTheme = themeSetting === 'system' ? systemTheme : themeSetting;

  useEffect(() => {
    if (!isReady || typeof document === 'undefined') return;
    const root = document.documentElement;

    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
    window.localStorage.setItem(STORAGE_KEY, themeSetting);
  }, [resolvedTheme, themeSetting, isReady]);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeSetting(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeSetting((prev) => {
      // If following system, flip the resolved theme once and lock it in.
      if (prev === 'system') {
        return resolvedTheme === 'dark' ? 'light' : 'dark';
      }
      return prev === 'dark' ? 'light' : 'dark';
    });
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeSetting,
      resolvedTheme,
      systemTheme,
      isReady,
      setTheme,
      toggleTheme,
    }),
    [themeSetting, resolvedTheme, systemTheme, isReady, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
