/**
 * Local development: the check pipeline and the price tracker in one process (`pnpm dev`), plus the X bot only when
 * asked for with X_BOT_DEV=1.
 *
 * The bot is opt-in here because its one-bot lock (bot:lock), since_id and the BotMention dedupe live in THIS
 * machine's Redis and Postgres: with the production OAuth keys in a local .env (a copied server .env), a dev worker
 * would be a second live @ApeCheckBot that the server's lock cannot see, and would answer again every recent mention
 * the server already answered. Run it against a separate test bot account.
 */
import { startBotWorker } from './bot/index';
import { loadWorkerEnv } from './env';
import { createLogger } from './log';
import { onShutdown, startCheckWorker, startPricesWorker } from './worker';

const env = loadWorkerEnv();
const log = createLogger('worker');
const checks = await startCheckWorker({ env, log: log.child('checks') });
const prices = await startPricesWorker({ env, log: log.child('prices') });
const botOptIn = process.env.X_BOT_DEV === '1';
// with X_BOT_DEV=1 it still idles with one warning unless the bot's X keys are in .env
const bot = botOptIn ? await startBotWorker({ env, log: log.child('bot') }) : null;
if (!bot) {
  log.child('bot').info('X bot off in pnpm dev (set X_BOT_DEV=1 to run it, with a test bot account: it posts for real)');
}
onShutdown(async () => {
  await bot?.close();
  await checks.close();
  await prices.close();
}, log);
