/** Local development: the check pipeline and the price tracker in one process (`pnpm dev`). */
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { onShutdown, startCheckWorker, startPricesWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('worker');
const checks = await startCheckWorker({ env, log: log.child('checks') });
const prices = await startPricesWorker({ env, log: log.child('prices') });
onShutdown(async () => {
  await checks.close();
  await prices.close();
}, log);
