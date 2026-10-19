/**
 * worker-bot (PM2): the X bot @ApeCheckBot (HANDOFF §7). Polls the bot's mentions, starts or reuses checks, and posts
 * the replies queued on "bot-replies". Without the X keys it says so once and idles, so PM2 keeps it online.
 */
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { startBotWorker } from './bot/index';
import { onShutdown } from './worker';

const env = loadWorkerEnv();
const log = createLogger('bot');
const handle = await startBotWorker({ env, log });
onShutdown(() => handle.close(), log);
