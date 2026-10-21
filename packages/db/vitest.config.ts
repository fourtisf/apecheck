import { defineConfig } from 'vitest/config';

/**
 * tiers.test.ts: unit tests (a fake balance reader). deployers.test.ts reads real Postgres: database apecheck_test_db,
 * created and migrated by test/global-setup.ts. Files run one at a time.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_db',
    },
  },
});
