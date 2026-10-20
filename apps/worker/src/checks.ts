/** worker-checks (PM2): the check pipeline on queue "checks", one Chromium per process (the isolated browser host in production). */
import { browserIsolationProblem } from './browser/browser';
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { checkBrowserAtStartup, onShutdown, startCheckWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('checks');
// production never opens untrusted pages in this process (it holds every secret): refuse to start without the host
const isolation = browserIsolationProblem(env);
if (isolation) {
  log.error(isolation);
  process.exit(1);
}
const handle = await startCheckWorker({ env, log });
onShutdown(() => handle.close(), log);
// say at startup whether the browser (host) works; in the background, jobs are already taken
void checkBrowserAtStartup(handle.browsers, env, log);
