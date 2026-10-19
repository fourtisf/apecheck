/** worker-prices (PM2): "since check" price points from DexScreener (HANDOFF §10). */
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { onShutdown, startPricesWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('prices');
const handle = await startPricesWorker({ env, log });
onShutdown(() => handle.close(), log);
