/**
 * worker-bot (PM2): the X bot @ApeCheckBot (HANDOFF §7). Polls the bot's mentions, starts or reuses checks, and posts
 * the replies queued on "bot-replies". Without the X keys it says so once and idles, so PM2 keeps it online.
 * It also answers the follow-up questions asked on the site (queue "asks", M3), whether or not the bot is set up.
 */
import { createAi } from './ai';
import { startAsksWorker } from './asks/index';
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { startBotWorker } from './bot/index';
import { onShutdown } from './worker';

const env = loadWorkerEnv();
const log = createLogger('bot');
const ai = createAi(env);
const handle = await startBotWorker({ env, log, ai });
const asks = await startAsksWorker({ env, ai, log: createLogger('asks') });
onShutdown(async () => {
  await handle.close();
  await asks.close();
}, log);
