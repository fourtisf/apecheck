/** Light/dark theme, same storage key and theme-color values as the prototype's setTheme(). */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'apecheck-theme';
export const THEME_COLOR: Record<Theme, string> = { light: '#FFFFFF', dark: '#0D0F12' };

/**
 * Runs inline in <head> before first paint, so a dark-theme visitor never sees a light flash.
 * Kept tiny and dependency-free on purpose.
 */
export const THEME_SCRIPT = `(function(){var t='light';try{t=localStorage.getItem('${THEME_KEY}')||'light'}catch(e){}if(t!=='dark')t='light';document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',t==='dark'?'${THEME_COLOR.dark}':'${THEME_COLOR.light}')})();`;

/** The visitor's saved choice ('light' when there is none, or storage is blocked). */
export function savedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Put the saved theme on <html> if it isn't there yet, without writing anything back. The head script does this
 * before paint on server-rendered pages, but a page React builds in the browser (Next's client-rendered error
 * shell for notFound() under /c/[id]) never runs that script and comes up with the layout's static "light".
 * The root layout then persists across client navigation, so without this the wrong theme would stick.
 */
export function applySavedTheme(): Theme {
  const t = savedTheme();
  if (currentTheme() !== t) setTheme(t, false);
  return t;
}

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
