/**
 * PM2 processes (HANDOFF §2, §12). Start from the repo root:
 *   pm2 start ecosystem.config.cjs && pm2 save
 *
 * api and the workers run their TypeScript directly through tsx (no bundling step);
 * every process reads the repo-root .env itself (loadEnv in @apecheck/core/node, next.config.mjs for web).
 */
const path = require('node:path');

const root = __dirname;
const tsx = { interpreter: 'node', interpreter_args: '--import tsx' };
const common = {
  env: { NODE_ENV: 'production' },
  time: true,
  merge_logs: true,
  max_restarts: 20,
  restart_delay: 3000,
  exp_backoff_restart_delay: 200,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'web',
      cwd: path.join(root, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      max_memory_restart: '1G',
    },
    {
      ...common,
      ...tsx,
      name: 'api',
      cwd: path.join(root, 'apps/api'),
      script: 'src/index.ts',
      max_memory_restart: '1G',
    },
    {
      ...common,
      ...tsx,
      name: 'worker-checks',
      cwd: path.join(root, 'apps/worker'),
      script: 'src/checks.ts',
      // one Chromium per process; MAX_CONCURRENT_BROWSERS contexts inside it (~0.5–1 GB each)
      max_memory_restart: '4G',
      // let a running check finish its current stage and mark itself before exit
      kill_timeout: 30000,
    },
    {
      ...common,
      ...tsx,
      name: 'worker-bot',
      cwd: path.join(root, 'apps/worker'),
      script: 'src/bot.ts',
      max_memory_restart: '512M',
    },
    {
      ...common,
      ...tsx,
      name: 'worker-prices',
      cwd: path.join(root, 'apps/worker'),
      script: 'src/prices.ts',
      max_memory_restart: '512M',
    },
  ],
};
