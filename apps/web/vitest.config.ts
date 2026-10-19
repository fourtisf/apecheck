import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure logic and server-rendered markup (react-dom/server), no browser, database or API.
 * The browser suite against a real API and `next start` is test/e2e (vitest.e2e.config.ts).
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**'],
  },
});
