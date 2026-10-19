import { defineConfig } from 'vitest/config';

/** Unit tests only (no database): tiers.ts rules with a fake balance reader. */
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
