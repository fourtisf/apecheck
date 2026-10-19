import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/*
 * Every process reads the repo-root .env (HANDOFF §12), or the file named by APECHECK_ENV_FILE (absolute, or
 * relative to the repo root), like loadEnv() in @apecheck/core/node. Next only looks for .env files next to this
 * config, so load it here. Variables already set in the environment win, which lets a dev run point the
 * web at another API (NEXT_PUBLIC_API_URL=... next dev). NODE_ENV is left to the Next CLI.
 * dotenv is resolved through @apecheck/core, which depends on it, so the web app needs no extra dependency.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const chosenEnv = (process.env.APECHECK_ENV_FILE || '').trim();
const rootEnv = chosenEnv ? path.resolve(repoRoot, chosenEnv) : path.join(repoRoot, '.env');
if (fs.existsSync(rootEnv)) {
  const dotenv = createRequire(new URL('../../packages/core/package.json', import.meta.url))('dotenv');
  const parsed = dotenv.parse(fs.readFileSync(rootEnv));
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'NODE_ENV' && process.env[key] === undefined) process.env[key] = value;
  }
}

const trimSlash = s => s.replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // several dev servers can share this folder (one per engineer / test run), each with its own build output
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@apecheck/core'],
  experimental: {
    // import { x } from '@apecheck/core' pulls only x's module, so zod (env.ts, schemas.ts) stays out of the browser bundle
    optimizePackageImports: ['@apecheck/core'],
  },
  // inlined into the browser bundle at build time; fall back to the server-side URLs from the same .env
  env: {
    NEXT_PUBLIC_API_URL: trimSlash(process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:4000'),
    NEXT_PUBLIC_APP_URL: trimSlash(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000'),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
