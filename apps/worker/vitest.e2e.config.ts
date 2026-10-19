import { defineConfig } from 'vitest/config';

/**
 * End-to-end: test/e2e/local.test.ts runs a real check through the queue against a local fixture site
 * (always); test/e2e/smoke.test.ts runs one real check against a public site (E2E=1 only, needs open internet).
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_worker',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2',
    },
  },
});
