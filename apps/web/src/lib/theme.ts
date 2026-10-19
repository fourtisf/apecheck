/** Light/dark theme, same storage key and theme-color values as the prototype's setTheme(). */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'apecheck-theme';
export const THEME_COLOR: Record<Theme, string> = { light: '#FFFFFF', dark: '#0D0F12' };

/**
 * Runs inline in <head> before first paint, so a dark-theme visitor never sees a light flash.
 * Kept tiny and dependency-free on purpose.
 */
export const THEME_SCRIPT = `(function(){var t='light';try{t=localStorage.getItem('${THEME_KEY}')||'light'}catch(e){}if(t!=='dark')t='light';document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='dark'?'${THEME_COLOR.dark}':'${THEME_COLOR.light}')})();`;

export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** setTheme() from the prototype: attribute, theme-color meta, and (unless init) the saved choice. */
export function setTheme(t: Theme, persist = true) {
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', THEME_COLOR[t]);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
}
