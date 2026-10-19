/**
 * Worker environment. Entry points call loadWorkerEnv() once; everything below takes the parsed
 * Env as an argument so tests can run with their own values (loadEnv() lets the repo-root .env win).
 */
import { loadEnv } from '@apecheck/core/node';
import type { Env } from '@apecheck/core';

export type { Env };

export function loadWorkerEnv(): Env {
  return loadEnv();
}
