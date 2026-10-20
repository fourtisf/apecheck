/**
 * PM2 processes (HANDOFF §2, §12). Start from the repo root:
 *   pm2 start ecosystem.config.cjs && pm2 save
 *
 * All five run as the app user (PM2 runs as that user and cannot switch users). The one process that must not hold
 * those secrets, Chromium, is not here: it is the systemd unit apecheck-browser.service (deploy/browser).
 *
 * api and the workers run their TypeScript directly through tsx (no bundling step);
 * every process reads the repo-root .env itself (loadEnv in @apecheck/core/node, next.config.mjs for web), or the
 * file named by APECHECK_ENV_FILE when that is set in the shell that starts PM2.
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
      // Chromium is not in this process: it runs as the apecheck-browser user in apecheck-browser.service
      // (deploy/browser, DEPLOY.md §6; MemoryMax=4G there) and this process drives it over BROWSER_WS_ENDPOINT.
      // It refuses to start in production without that endpoint.
      max_memory_restart: '1G',
      // let a running check finish its current stage and mark itself before exit
      kill_timeout: 30000,
    },
    {
      ...common,
      ...tsx,
      name: 'worker-bot',
      cwd: path.join(root, 'apps/worker'),
      // the X bot (M2): polls @ApeCheckBot's mentions, starts/reuses checks, posts the replies queued on bot-replies.
      // One instance: a Redis lock (bot:lock) keeps any second copy on standby. Without the X OAuth 1.0a keys in .env
      // it logs one warning and idles, so PM2 keeps it online (DEPLOY.md §14).
      // M3: it also answers the site's follow-up questions (queue "asks"), with or without X keys: when it is down,
      // POST /v1/checks/:id/asks answers 504 after 45 s.
      script: 'src/bot.ts',
      instances: 1,
      max_memory_restart: '512M',
      // let a reply that is uploading its card or posting finish (and be recorded) before exit
      kill_timeout: 30000,
    },
    {
      ...common,
      ...tsx,
      name: 'worker-prices',
      cwd: path.join(root, 'apps/worker'),
      // price tracking and the daily screenshot cleanup; M3: re-check alerts for watchlists (queue "rechecks"; Max
      // watchers' automatic re-checks go to worker-checks), the daily deployer refresh and the hourly tier refresh;
      // M4: webhook deliveries (queue "webhooks": check.completed from worker-checks, watch.changed from the re-check
      // alerts, test pings from the API), signed and POSTed through the SSRF guard with retries over ~6 h. While it is
      // down, deliveries wait in the queue (none are lost; a sweep re-queues any whose job went missing).
      script: 'src/prices.ts',
      max_memory_restart: '512M',
    },
  ],
};
