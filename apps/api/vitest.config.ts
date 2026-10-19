import { defineConfig } from 'vitest/config';

/**
 * Tests run against real Postgres + Redis, isolated from dev data: database apecheck_test_api
 * (created and migrated by test/global-setup.ts) and Redis db 1. Files share that state, so
 * they run one at a time.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_api',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
    },
  },
});
