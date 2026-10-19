import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Browser suite: Chromium (Playwright) against `next start` and the real API on an isolated database
 * (test/e2e/global-setup.ts). Needs local Postgres + Redis. Files share the servers, so they run one at a time.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
