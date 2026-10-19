/**
 * The saved theme must win over whatever <html> came up with. Next serves notFound() under /c/[id] as a
 * client-rendered error shell: React builds the document, the inline head script never runs, and <html> carries
 * the layout's static data-theme="light". ThemeToggle calls applySavedTheme() on mount to correct it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_COLOR, THEME_KEY, applySavedTheme, savedTheme } from '@/lib/theme';

let store: Map<string, string>;
let blocked = false;
const meta = { content: THEME_COLOR.light, setAttribute(_: string, v: string) { this.content = v; } };
const html = { dataset: {} as Record<string, string> };

beforeEach(() => {
  store = new Map();
  blocked = false;
  meta.content = THEME_COLOR.light;
  html.dataset = { theme: 'light' }; // what the layout renders, and all a client-rendered shell has
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: (s: string) => (s === 'meta[name=theme-color]' ? meta : null) };
  g.localStorage = {
    getItem: (k: string) => {
      if (blocked) throw new Error('SecurityError');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (blocked) throw new Error('SecurityError');
      store.set(k, v);
    },
  };
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.localStorage;
});

describe('applySavedTheme', () => {
  it('turns a light shell dark for a visitor who chose dark, without writing anything', () => {
    store.set(THEME_KEY, 'dark');
    expect(applySavedTheme()).toBe('dark');
    expect(html.dataset.theme).toBe('dark');
    expect(meta.content).toBe(THEME_COLOR.dark);
    expect(store.get(THEME_KEY)).toBe('dark');
    expect(store.size).toBe(1);
  });

  it('leaves a page the head script already themed alone', () => {
    store.set(THEME_KEY, 'dark');
    html.dataset.theme = 'dark';
    meta.content = 'untouched';
    expect(applySavedTheme()).toBe('dark');
    expect(meta.content).toBe('untouched');
  });

  it('is light without a saved choice, with an unknown value, or when storage is blocked', () => {
    expect(applySavedTheme()).toBe('light');
    store.set(THEME_KEY, 'sepia');
    expect(savedTheme()).toBe('light');
    blocked = true;
    expect(savedTheme()).toBe('light');
    html.dataset.theme = 'dark';
    expect(applySavedTheme()).toBe('light');
    expect(html.dataset.theme).toBe('light');
  });
});
