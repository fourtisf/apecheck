/** Minimal DTOs for rendering components in tests. Only what the components read; the rest is typed loosely. */
import type { CheckReportDTO, CheckSummaryDTO, FeedResponse } from '@apecheck/core';

export function summary(o: Partial<CheckSummaryDTO> = {}): CheckSummaryDTO {
  return {
    id: 'abc1234',
    targetId: 't1',
    kind: 'site',
    status: 'done',
    name: 'orbitswap.xyz',
    title: 'Orbit',
    ticker: null,
    domain: 'orbitswap.xyz',
    handle: null,
    ca: null,
    chain: null,
    hue: 210,
    narScore: 37,
    coinScore: null,
    total: 37,
    narBand: 'llarp',
    coinBand: null,
    hasCoin: false,
    summary: "The app loads but the main flow stops at 'Coming soon'.",
    mc: null,
    vol5m: null,
    since: null,
    spark: null,
    checks: 1,
    asks: 0,
    via: 'web',
    by: null,
    mine: false,
    createdAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
    checkedAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
    deployer: null,
    ...o,
  };
}

export function report(o: Partial<CheckReportDTO> = {}): CheckReportDTO {
  const s = summary(o);
  return {
    ...s,
    targetRaw: s.domain ?? s.name,
    signals: { launch: null, flow: null, docs: null, acct: null, git: null },
    evidence: {},
    areas: null,
    coinSummary: null,
    claims: [],
    steps: [],
    stepsExpected: 12,
    progress: 1,
    narrative: null,
    coin: null,
    market: null,
    people: {
      handle: null,
      acct: { signal: null, createdAt: null, age: null, followers: null, followersText: null, verified: null, renamed: null, quality: null },
      team: { signal: null, text: null },
      git: { signal: null, text: null },
      docs: { signal: null, text: null },
    },
    asksList: [],
    notes: [],
    links: { site: null, x: null, github: [], docs: null },
    durationMs: 90_000,
    startedAt: s.createdAt,
    finishedAt: s.checkedAt,
    error: null,
    isPrivate: false,
    cardUrl: null,
    reportUrl: `http://localhost:3000/c/${s.id}`,
    report_url: `http://localhost:3000/c/${s.id}`,
    post: null,
    ...o,
  } as CheckReportDTO;
}

export const feedOf = (items: CheckSummaryDTO[]): FeedResponse => ({ items, total: items.length, nextCursor: null });
