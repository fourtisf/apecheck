/**
 * `pnpm diagnose` (repo root): checks every dependency a real check needs, read-only, and prints one row per
 * dependency with what to fix (src/doctor/). Run it on the server as the app user, from the checkout:
 *   sudo -iu apecheck
 *   cd /srv/apecheck/app && pnpm diagnose
 * (not "doctor": `pnpm doctor` is pnpm's own built-in command, which prints nothing.)
 * Exit code 1 when any row is FAIL. It reads the same .env as the workers (loadWorkerEnv) and never writes anything.
 */
import { loadWorkerEnv } from './env';
import { runDoctor } from './doctor/index';
import { Redactor } from './doctor/redact';
import { errorText } from './doctor/result';

let code = 1;
let redact = (s: string) => s;
try {
  const env = loadWorkerEnv();
  redact = s => new Redactor(env).text(s);
  const run = await runDoctor(env);
  console.log(run.report);
  code = run.code;
} catch (e) {
  // only the setup can get here (every probe has its own timeout and never throws)
  console.error(redact(`doctor could not run: ${errorText(e)}`));
  code = 1;
}
// open sockets of probes that timed out must not keep the command alive
process.exit(code);
