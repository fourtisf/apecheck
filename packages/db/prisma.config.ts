/**
 * Prisma CLI config. Loads the repo-root .env (one .env for the whole monorepo, or APECHECK_ENV_FILE),
 * so `pnpm --filter @apecheck/db prisma migrate deploy` works from any cwd.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

function repoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

const root = repoRoot(process.cwd());
// same file the app processes read (loadEnv in @apecheck/core/node): APECHECK_ENV_FILE, else <root>/.env.
// Variables already set win, so `DATABASE_URL=... prisma migrate deploy` (test setups) targets that database.
const chosen = process.env.APECHECK_ENV_FILE?.trim();
const envFile = chosen ? path.resolve(root, chosen) : path.join(root, '.env');
if (fs.existsSync(envFile)) config({ path: envFile, quiet: true } as Parameters<typeof config>[0]);

export default defineConfig({
  schema: path.join(root, 'packages/db/prisma/schema.prisma'),
  migrations: { path: path.join(root, 'packages/db/prisma/migrations') },
});
