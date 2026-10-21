/**
 * worker-prices (PM2): the light periodic work, no browser —
 *  - "since check" price points from DexScreener (HANDOFF §10) and the daily screenshot cleanup (queue "prices");
 *  - re-check alerts for watched targets: fingerprints, notifications, Max automatic re-checks (queue "rechecks", M3);
 *  - the hourly tier refresh (queue "maintenance", M3);
 *  - webhook deliveries: check.completed, watch.changed and test pings, signed and POSTed with retries (queue
 *    "webhooks", M4).
 */
import { createSources } from '@apecheck/sources';
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { startMaintenanceWorker } from './maintenance/index';
import { startWatchWorker } from './watch/index';
import { startWebhooksWorker } from './webhooks/index';
import { onShutdown, startPricesWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('prices');
const sources = createSources(env);
const prices = await startPricesWorker({ env, log, sources });
const watch = await startWatchWorker({ env, sources, log: createLogger('watch') });
const maintenance = await startMaintenanceWorker({ env, sources, log: createLogger('maintenance') });
const webhooks = await startWebhooksWorker({ env, sources, log: createLogger('webhooks') });
onShutdown(async () => {
  await webhooks.close();
  await watch.close();
  await maintenance.close();
  await prices.close();
}, log);
