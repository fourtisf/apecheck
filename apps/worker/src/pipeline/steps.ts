/**
 * StepLogger: every step of a check goes to the CheckStep table AND to Redis (check:{id} channel +
 * progress key) so the report page can stream it (HANDOFF §4, §6). Steps are written strictly in order.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@apecheck/db';
import {
  checkChannel,
  clamp,
  clip,
  progressKey,
  stepStatusToDb,
  type CheckChannelMsg,
  type StepDTO,
  type StepSource,
  type StepStatusS,
} from '@apecheck/core';
import type { Logger } from '../log';

export interface StepInput {
  status: StepStatusS;
  /** one plain sentence, like the prototype log */
  text: string;
  source?: StepSource | null;
  url?: string | null;
  /** caption pill on the screenshot */
  caption?: string | null;
  /** JPEG bytes; saved as SCREENSHOT_DIR/<checkId>/<idx>.jpg */
  shot?: Buffer | null;
}

export interface LoggedStep {
  idx: number;
  tMs: number;
  status: StepStatusS;
  text: string;
  source: string | null;
  url: string | null;
  caption: string | null;
  screenshot: string | null;
}

export interface StepSink {
  /** resolves to the step idx, or -1 when the step was dropped (its stage already ended) */
  step(s: StepInput): Promise<number>;
}

export interface StepLoggerDeps {
  prisma: PrismaClient;
  redis: Redis;
  screenshotDir: string;
  log: Logger;
}

export class StepLogger implements StepSink {
  readonly rows: LoggedStep[] = [];
  private next = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private progressValue = 0;

  constructor(
    private readonly deps: StepLoggerDeps,
    private readonly check: { id: string; shortId: string },
    private readonly startedAt: number,
  ) {}

  get progress(): number {
    return this.progressValue;
  }

  /** Progress only moves forward. Written to the progress key (TTL 1h) without waiting. */
  setProgress(p: number): void {
    const v = clamp(p, 0, 1);
    if (v <= this.progressValue) return;
    this.progressValue = v;
    this.deps.redis.set(progressKey(this.check.id), v.toFixed(3), 'EX', 3600).catch(e => this.deps.log.warn('progress write failed', e));
  }

  step(s: StepInput): Promise<number> {
    const idx = this.next++;
    const tMs = Math.max(0, Date.now() - this.startedAt);
    const run = this.chain.then(() => this.write(idx, tMs, s));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A sink that drops steps once `signal` has aborted (a timed-out stage can't log after the fact). */
  scoped(signal: AbortSignal): StepSink {
    return { step: s => (signal.aborted ? Promise.resolve(-1) : this.step(s)) };
  }

  /** Wait for every step queued so far. */
  async flush(): Promise<void> {
    await this.chain;
  }

  private async write(idx: number, tMs: number, s: StepInput): Promise<number> {
    let screenshot: string | null = null;
    if (s.shot && s.shot.length) {
      const rel = `${this.check.id}/${idx}.jpg`;
      try {
        await fs.mkdir(path.join(this.deps.screenshotDir, this.check.id), { recursive: true });
        await fs.writeFile(path.join(this.deps.screenshotDir, rel), s.shot);
        screenshot = rel;
      } catch (e) {
        this.deps.log.warn(`could not save screenshot ${rel}`, e);
      }
    }
    const row: LoggedStep = {
      idx,
      tMs,
      status: s.status,
      text: clip(s.text.replace(/\s+/g, ' ').trim(), 300),
      source: s.source ?? null,
      url: s.url ? s.url.slice(0, 1000) : null,
      caption: s.caption ? clip(s.caption, 80) : null,
      screenshot,
    };
    await this.deps.prisma.checkStep.create({
      data: {
        checkId: this.check.id,
        idx,
        tMs,
        status: stepStatusToDb(row.status),
        text: row.text,
        source: row.source,
        url: row.url,
        caption: row.caption,
        screenshot: row.screenshot,
      },
    });
    this.rows.push(row);
    const dto: StepDTO = {
      idx,
      t: tMs,
      status: row.status,
      text: row.text,
      source: row.source,
      url: row.url,
      caption: row.caption,
      screenshot: screenshot ? `/shots/${screenshot}` : null,
    };
    await this.publish({ type: 'step', step: dto, progress: this.progressValue });
    await this.deps.redis.set(progressKey(this.check.id), this.progressValue.toFixed(3), 'EX', 3600).catch(e => this.deps.log.warn('progress write failed', e));
    return idx;
  }

  async publish(msg: CheckChannelMsg): Promise<void> {
    try {
      await this.deps.redis.publish(checkChannel(this.check.id), JSON.stringify(msg));
    } catch (e) {
      this.deps.log.warn('publish failed', e);
    }
  }
}
