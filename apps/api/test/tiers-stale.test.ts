/**
 * Failed balance reads keep a paid tier for at most TIER_STALE_MAX_MS after the last successful read (User.tierReadAt),
 * so a wallet that makes its own reads fail (or a long RPC outage) can't keep Pro/Max after selling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MeDTO } from '@apecheck/core';
import { TIER_CACHE_MS, TIER_STALE_MAX_MS } from '@apecheck/db';
import { Client, SolWallet, makeHarness, resetState, signedIn, type Harness } from './helpers';

const MINT = 'APEcheckMint1111111111111111111111111111111';

describe('failed balance reads', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TOKEN_ADDRESS: MINT, TOKEN_CHAIN: 'sol', PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    h.sources.balances.clear();
    h.sources.balanceCalls = [];
  });

  it('sign-in stores the time of the successful read', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 3_000_000);
    await signedIn(new Client(h.app), w);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { solAddress: w.address } });
    expect(row.tierReadAt!.getTime()).toBe(row.tierCheckedAt!.getTime());
  });

  it('keep Max while the last good read is under a day old, then Free (not a holder) until a read succeeds', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 3_000_000);
    const c = new Client(h.app);
    await signedIn(c, w);
    h.sources.balances.set(w.address, null);

    // 23 h after the last good read: the read fails, Max is kept
    const recent = new Date(Date.now() - TIER_STALE_MAX_MS + 3600_000);
    await h.prisma.user.updateMany({ data: { tierReadAt: recent, tierCheckedAt: new Date(Date.now() - 2 * TIER_CACHE_MS) } });
    expect((await c.get('/v1/me')).json<MeDTO>()).toMatchObject({ tier: 'max', user: { tier: 'max', holding: 3_000_000, holder: true } });
    const kept = await h.prisma.user.findUniqueOrThrow({ where: { solAddress: w.address } });
    expect(kept.tierReadAt).toEqual(recent);
    expect(kept.tier).toBe('MAX');

    // a day after it: dropped and stored, the last good read time kept
    const old = new Date(Date.now() - TIER_STALE_MAX_MS - 60_000);
    await h.prisma.user.updateMany({ data: { tierReadAt: old, tierCheckedAt: new Date(Date.now() - 2 * TIER_CACHE_MS) } });
    const me = (await c.get('/v1/me')).json<MeDTO>();
    expect(me).toMatchObject({ tier: 'free', max: 5, user: { tier: 'free', holding: null, holder: false } });
    const row = await h.prisma.user.findUniqueOrThrow({ where: { solAddress: w.address } });
    expect(row).toMatchObject({ tier: 'FREE', holding: null, tierReadAt: old });
    // Max-only features are gone with it
    const priv = await c.post('/v1/checks', { target: 'private-site.xyz', private: true });
    expect(priv.statusCode).toBe(403);
    expect(priv.json<{ code: string }>().code).toBe('max_required');

    // the wallet answers again: back to Max
    h.sources.balances.set(w.address, 3_000_000);
    await h.prisma.user.updateMany({ data: { tierCheckedAt: new Date(Date.now() - 2 * TIER_CACHE_MS) } });
    expect((await c.get('/v1/me')).json<MeDTO>()).toMatchObject({ tier: 'max', user: { holding: 3_000_000 } });
    const back = await h.prisma.user.findUniqueOrThrow({ where: { solAddress: w.address } });
    expect(Date.now() - back.tierReadAt!.getTime()).toBeLessThan(60_000);
  });
});
