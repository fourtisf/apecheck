/**
 * worker-bot (PM2): the X bot is milestone M2. Until then this process says so once and idles until PM2 stops it,
 * so PM2 shows it online instead of restarting an exited process over and over. M2 replaces this file.
 */
export {};

console.log('[bot] X bot arrives in M2; idling until stopped');

// an interval keeps the event loop alive; it does no work
const keepAlive = setInterval(() => undefined, 1 << 30);
const stop = (signal: string) => {
  clearInterval(keepAlive);
  console.log(`[bot] ${signal}: stopped`);
  process.exit(0);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
