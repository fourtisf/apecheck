/** worker-prices: daily screenshot cleanup (HANDOFF §12.6) — the selection rule and one run against the test database. */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log';
import { cleanupShots, findExpiredShots, selectExpired, topListCheckIds } from '../src/maintenance/shots';
import { prisma, resetDb, tmpDir } from './helpers';

const DAY = 86_400_000;
const now = Date.parse('2026-10-19T12:00:00Z');
const ago = (days: number) => new Date(now - days * DAY);

describe('selectExpired', () => {
  const c = (id: string, finishedAt: Date | null) => ({ id, shortId: id, finishedAt });

  it('picks checks finished more than keepDays ago that are not on a top list', () => {
    const list = [c('old', ago(31)), c('edge', ago(30)), c('recent', ago(29)), c('top', ago(90)), c('never', null)];
    expect(selectExpired(list, new Set(['top']), now, 30).map(x => x.id)).toEqual(['old']);
    expect(selectExpired(list, new Set(), now, 30).map(x => x.id)).toEqual(['old', 'top']);
    expect(selectExpired(list, new Set(), now, 10).map(x => x.id)).toEqual(['old', 'edge', 'recent', 'top']);
  });
});

describe('screenshot cleanup', () => {
  beforeEach(() => resetDb());
  afterAll(() => prisma.$disconnect());

  let n = 0;
  async function check(o: {
    finishedDaysAgo: number | null;
    total?: number | null;
    checkCount?: number;
    status?: 'DONE' | 'FAILED' | 'RUNNING';
    isLatest?: boolean;
    isPrivate?: boolean;
    shots?: boolean;
    card?: boolean;
  }) {
    const i = n++;
    const t = await prisma.target.create({ data: { key: `site:s${i}.xyz`, kind: 'SITE', name: `s${i}.xyz`, domain: `s${i}.xyz`, checkCount: o.checkCount ?? 1 } });
    const shortId = `sh${String(i).padStart(5, '0')}`;
    const status = o.status ?? 'DONE';
    const row = await prisma.check.create({
      data: {
        shortId,
        targetId: t.id,
        targetRaw: `s${i}.xyz`,
        status,
        isLatest: o.isLatest ?? status === 'DONE',
        isPrivate: o.isPrivate ?? false,
        totalScore: o.total === undefined ? 50 : o.total,
        finishedAt: o.finishedDaysAgo == null ? null : ago(o.finishedDaysAgo),
        cardPath: o.card === false ? null : `cards/${shortId}.png`,
      },
    });
    await prisma.checkStep.createMany({
      data: [
        { checkId: row.id, idx: 0, tMs: 0, status: 'INFO', text: 'Opening', screenshot: o.shots === false ? null : `${row.id}/0.jpg` },
        { checkId: row.id, idx: 1, tMs: 900, status: 'OK', text: 'Loaded', screenshot: o.shots === false ? null : `${row.id}/1.jpg` },
        { checkId: row.id, idx: 2, tMs: 1200, status: 'INFO', text: 'Scoring' },
      ],
    });
    return row;
  }

  function files(dir: string, rows: { id: string; shortId: string }[]) {
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    for (const r of rows) {
      fs.mkdirSync(path.join(dir, r.id), { recursive: true });
      fs.writeFileSync(path.join(dir, r.id, '0.jpg'), 'x');
      fs.writeFileSync(path.join(dir, r.id, '1.jpg'), 'x');
      fs.writeFileSync(path.join(dir, 'cards', `${r.shortId}.png`), 'x');
    }
  }

  it('keeps the top lists (most checked, most real, least real) and everything recent; cleans the rest', async () => {
    // top lists with top = 1: most checked = mostChecked, most real = best, least real = worst
    const mostChecked = await check({ finishedDaysAgo: 60, checkCount: 99 });
    const best = await check({ finishedDaysAgo: 60, total: 95 });
    const worst = await check({ finishedDaysAgo: 60, total: 3 });
    const plain = await check({ finishedDaysAgo: 45, total: 50 });
    const failed = await check({ finishedDaysAgo: 40, status: 'FAILED', isLatest: false, total: null });
    const older = await check({ finishedDaysAgo: 50, isLatest: false });
    const privateOld = await check({ finishedDaysAgo: 40, isPrivate: true, total: 99 });
    const recent = await check({ finishedDaysAgo: 5 });
    const running = await check({ finishedDaysAgo: null, status: 'RUNNING', isLatest: false });
    const nothingLeft = await check({ finishedDaysAgo: 70, shots: false, card: false });

    const top = await topListCheckIds(prisma, 1);
    expect([...top].sort()).toEqual([mostChecked.id, best.id, worst.id].sort());

    const expired = await findExpiredShots(prisma, { now, top: 1 });
    expect(expired.map(e => e.id).sort()).toEqual([plain.id, failed.id, older.id, privateOld.id].sort());

    const dir = tmpDir('apecheck-shots-cleanup-');
    const all = [mostChecked, best, worst, plain, failed, older, privateOld, recent, running, nothingLeft];
    files(dir, all);
    const res = await cleanupShots({ prisma, screenshotDir: dir, log: memoryLogger() }, { now, top: 1, batch: 2 });
    expect(res).toEqual({ checks: 4, folders: 4, cards: 4 });

    const cleaned = new Set([plain.id, failed.id, older.id, privateOld.id]);
    for (const r of all) {
      const gone = cleaned.has(r.id);
      expect(fs.existsSync(path.join(dir, r.id)), r.shortId).toBe(!gone);
      expect(fs.existsSync(path.join(dir, 'cards', `${r.shortId}.png`)), r.shortId).toBe(!gone);
      const steps = await prisma.checkStep.findMany({ where: { checkId: r.id }, orderBy: { idx: 'asc' } });
      const row = await prisma.check.findUniqueOrThrow({ where: { id: r.id } });
      if (gone) {
        // no broken images: the report shows no screenshot and no stored card for these
        expect(steps.every(s => s.screenshot == null)).toBe(true);
        expect(row.cardPath).toBeNull();
        expect(steps).toHaveLength(3);
      } else if (r.id !== nothingLeft.id) {
        expect(steps.filter(s => s.screenshot).length).toBe(2);
        expect(row.cardPath).toBe(`cards/${r.shortId}.png`);
      }
    }

    // a second run has nothing left to do
    expect(await cleanupShots({ prisma, screenshotDir: dir, log: memoryLogger() }, { now, top: 1 })).toEqual({ checks: 0, folders: 0, cards: 0 });
  });

  it('never touches paths outside SCREENSHOT_DIR', async () => {
    const dir = tmpDir('apecheck-shots-guard-');
    const outside = tmpDir('apecheck-shots-outside-');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    const t = await prisma.target.create({ data: { key: 'site:evil.xyz', kind: 'SITE', name: 'evil.xyz', domain: 'evil.xyz' } });
    // ids never look like this in practice (cuid / 7-char short id); the guard still refuses them
    await prisma.check.create({
      data: { id: `../${path.basename(outside)}`, shortId: '../x', targetId: t.id, targetRaw: 'evil.xyz', status: 'DONE', isLatest: false, finishedAt: ago(90), cardPath: 'cards/x.png' },
    });
    const res = await cleanupShots({ prisma, screenshotDir: dir, log: memoryLogger() }, { now, top: 0 });
    expect(res).toEqual({ checks: 1, folders: 0, cards: 0 });
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});
