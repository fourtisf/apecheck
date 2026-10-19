/** worker-checks (PM2): the check pipeline on queue "checks", one Chromium per process. */
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { onShutdown, startCheckWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('checks');
const handle = await startCheckWorker({ env, log });
onShutdown(() => handle.close(), log);
