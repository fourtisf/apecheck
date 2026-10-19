'use client';
import { useEffect, useState } from 'react';
import { currentTheme, setTheme, type Theme } from '@/lib/theme';
import { MoonIcon, SunIcon } from './icons';

/**
 * Light/dark switch (#themeBtn). The inline head script has already applied the saved theme; both icons
 * are in the markup and CSS shows the right one, so nothing flips after hydration.
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>('light');
  useEffect(() => setThemeState(currentTheme()), []);
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
