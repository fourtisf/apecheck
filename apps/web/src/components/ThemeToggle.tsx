'use client';
import { useEffect, useLayoutEffect, useState } from 'react';
import { applySavedTheme, currentTheme, setTheme, type Theme } from '@/lib/theme';
import { MoonIcon, SunIcon } from './icons';

// before paint in the browser (no light flash on a client-rendered page), and no server warning
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Light/dark switch (#themeBtn). On server-rendered pages the inline head script has already applied the saved
 * theme; both icons are in the markup and CSS shows the right one, so nothing flips after hydration.
 * On mount it applies the saved theme again: a page React renders in the browser (the error shell Next serves
 * for notFound() under /c/[id]) never ran the head script and would otherwise stay light for the whole visit.
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>('light');
  useIsoLayoutEffect(() => setThemeState(applySavedTheme()), []);
  return (
    <button
      className="icon-btn"
      id="themeBtn"
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      suppressHydrationWarning
      onClick={() => {
        const t = currentTheme() === 'dark' ? 'light' : 'dark';
        setTheme(t);
        setThemeState(t);
      }}
    >
      <SunIcon className="theme-ic-sun" />
      <MoonIcon className="theme-ic-moon" />
    </button>
  );
}
