import { defineConfig } from 'vitest/config';

/**
 * Worker tests run against real Postgres (database apecheck_test_worker, created and migrated by
 * test/global-setup.ts), Redis db 2 and a real headless Chromium. Files share that state and the
 * browser is heavy, so they run one at a time. test/e2e/* runs with vitest.e2e.config.ts.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_worker',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2',
    },
  },
});
