/** Coin logos: Target.logo → `logo` on feed rows, live checks, coins and the report; served from /shots/logos/. */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckReportDTO, CoinsResponse, FeedResponse, LiveResponse } from '@apecheck/core';
import { logoUrl } from '../src/mappers';
import { Client, makeHarness, resetState, seedCheck, seedCoinFacts, seedTarget, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const SHA = 'a'.repeat(64);
const MINT = 'CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

describe('logoUrl', () => {
  it('only a stored logos/<sha256>.<ext> path becomes /shots/logos/…', () => {
    expect(logoUrl(`logos/${SHA}.png`)).toBe(`/shots/logos/${SHA}.png`);
    expect(logoUrl(`logos/${SHA}.gif`)).toBe(`/shots/logos/${SHA}.gif`);
    expect(logoUrl(null)).toBeNull();
    expect(logoUrl(`logos/${SHA}.svg`)).toBeNull();
    expect(logoUrl('https://dd.dexscreener.com/ds-data/tokens/solana/x.png')).toBeNull();
    expect(logoUrl(`../logos/${SHA}.png`)).toBeNull();
  });
});

describe('logo in the DTOs', () => {
  it('feed rows, coins, live checks and the report carry it; rows without one have null', async () => {
    const coin = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: MINT, ticker: 'KIMCHI', name: '$KIMCHI', key: `ca:sol:${MINT}`, logo: `logos/${SHA}.png` });
    const done = await seedCheck(h.prisma, { targetId: coin.id, narScore: 40, narBand: 'partly', totalScore: 40, coinScore: 50 });
    await seedCoinFacts(h.prisma, done.id);
    const old = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: old.id, narScore: 70, narBand: 'likely', totalScore: 70 });
    await seedCheck(h.prisma, { targetId: coin.id, status: 'RUNNING', isLatest: false, createdAt: new Date(), startedAt: new Date() });
    const c = new Client(h.app);

    const feed = (await c.get('/v1/feed')).json() as FeedResponse;
    const byId = new Map(feed.items.map(i => [i.targetId, i]));
    expect(byId.get(coin.id)?.logo).toBe(`/shots/logos/${SHA}.png`);
    expect(byId.get(old.id)?.logo).toBeNull();

    const coins = (await c.get('/v1/coins')).json() as CoinsResponse;
    expect(coins.items[0].logo).toBe(`/shots/logos/${SHA}.png`);

    const live = (await c.get('/v1/live')).json() as LiveResponse;
    expect(live.items[0]).toMatchObject({ ticker: 'KIMCHI', logo: `/shots/logos/${SHA}.png` });

    const report = (await c.get(`/v1/checks/${done.shortId}`)).json() as CheckReportDTO;
    expect(report.logo).toBe(`/shots/logos/${SHA}.png`);
  });
});

describe('/shots/logos', () => {
  it('serves a stored logo as an image (nosniff, sandboxed); never an SVG', async () => {
    fs.mkdirSync(path.join(h.shotsDir, 'logos'), { recursive: true });
    fs.writeFileSync(path.join(h.shotsDir, 'logos', `${SHA}.png`), PNG);
    fs.writeFileSync(path.join(h.shotsDir, 'logos', `${SHA}.gif`), 'GIF89a....');
    fs.writeFileSync(path.join(h.shotsDir, 'logos', `${SHA}.svg`), '<svg><script>alert(1)</script></svg>');
    const png = await h.app.inject({ method: 'GET', url: `/shots/logos/${SHA}.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect(String(png.headers['content-security-policy'])).toContain('sandbox');
    const gif = await h.app.inject({ method: 'GET', url: `/shots/logos/${SHA}.gif` });
    expect(gif.statusCode).toBe(200);
    expect(gif.headers['content-type']).toBe('image/gif');
    const svg = await h.app.inject({ method: 'GET', url: `/shots/logos/${SHA}.svg` });
    expect(svg.statusCode).toBe(404);
  });
});
