import { describe, expect, it } from 'vitest';
import { EnvZ } from '@apecheck/core';
import {
  TIER_CACHE_MS,
  TIER_RETRY_MS,
  TIER_STALE_MAX_MS,
  computeTier,
  higherTier,
  overrideTier,
  parseTierOverrides,
  storedTier,
  tierFromHolding,
  tierUpdate,
  tokenWallets,
  type ReadBalance,
  type TierUser,
} from '../src/tiers';

const EVM = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = 'APEcheckMint1111111111111111111111111111111';
const NOW = new Date('2026-10-19T12:00:00Z');

const env = (vars: Record<string, string> = {}) =>
  EnvZ.parse({ TOKEN_CHAIN: 'sol', PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000', ...vars });
const live = (vars: Record<string, string> = {}) => env({ TOKEN_ADDRESS: MINT, ...vars });

const user = (u: Partial<TierUser> = {}): TierUser => ({ evmAddress: null, solAddress: SOL, tierCheckedAt: null, holding: null, ...u });

/** balance reader that records its calls and answers from a table (owner → amount, or null/throw) */
function reader(table: Record<string, number | null | 'throw'>) {
  const calls: { chain: string; token: string; owner: string }[] = [];
  const read: ReadBalance = async w => {
    calls.push(w);
    const v = table[w.owner];
    if (v === 'throw') throw new Error('rpc down');
    return v === undefined ? 0 : v;
  };
  return { read, calls };
}

describe('tier rules', () => {
  it('holding thresholds: >= MAX_MIN_HOLD max, >= PRO_MIN_HOLD pro, else free', () => {
    const e = env();
    expect(tierFromHolding(e, null)).toBe('free');
    expect(tierFromHolding(e, 0)).toBe('free');
    expect(tierFromHolding(e, 249_999.99)).toBe('free');
    expect(tierFromHolding(e, 250_000)).toBe('pro');
    expect(tierFromHolding(e, 2_499_999)).toBe('pro');
    expect(tierFromHolding(e, 2_500_000)).toBe('max');
  });

  it('higherTier never lowers', () => {
    expect(higherTier('free', 'pro')).toBe('pro');
    expect(higherTier('max', 'pro')).toBe('max');
    expect(higherTier('pro', null)).toBe('pro');
  });

  it('parses TIER_OVERRIDES: EVM keys lowercased, Solana kept as is, junk skipped, the higher tier wins', () => {
    const m = parseTierOverrides([`${EVM}:PRO`, `${SOL}:max`, 'nocolon', ':max', `${SOL.toLowerCase()}:pro`, 'abc:gold', `${EVM}:max`]);
    expect(Object.fromEntries(m)).toEqual({ [EVM.toLowerCase()]: 'max', [SOL]: 'max', [SOL.toLowerCase()]: 'pro' });
  });

  it('overrideTier: EVM matches case-insensitively, Solana exactly', () => {
    const e = env({ TIER_OVERRIDES: `${EVM.toLowerCase()}:pro, ${SOL}:max` });
    expect(overrideTier(e, { evmAddress: EVM, solAddress: null })).toBe('pro');
    expect(overrideTier(e, { evmAddress: null, solAddress: SOL })).toBe('max');
    expect(overrideTier(e, { evmAddress: EVM, solAddress: SOL })).toBe('max');
    expect(overrideTier(e, { evmAddress: null, solAddress: SOL.toLowerCase() })).toBeNull();
    expect(overrideTier(env(), { evmAddress: EVM, solAddress: SOL })).toBeNull();
  });

  it('token wallets follow TOKEN_CHAIN: the Solana wallet for sol, the EVM wallet for an EVM chain, none for Tron', () => {
    const u = { evmAddress: EVM, solAddress: SOL };
    expect(tokenWallets(env({ TOKEN_CHAIN: 'sol' }), u)).toEqual([SOL]);
    expect(tokenWallets(env({ TOKEN_CHAIN: 'base' }), u)).toEqual([EVM]);
    expect(tokenWallets(env({ TOKEN_CHAIN: 'trx' }), u)).toEqual([]);
    expect(tokenWallets(env({ TOKEN_CHAIN: 'sol' }), { evmAddress: EVM, solAddress: null })).toEqual([]);
  });
});

describe('computeTier', () => {
  it('token not live: everyone free, holding null, nothing read', async () => {
    const r = reader({ [SOL]: 9e9 });
    const res = await computeTier({ env: env(), user: user(), readBalance: r.read, now: NOW, force: true });
    expect(res).toMatchObject({ tier: 'free', holding: null, holder: false, override: null, read: false, failed: false });
    expect(r.calls).toHaveLength(0);
  });

  it('token not live: an override gives its tier and counts as a holder', async () => {
    const r = reader({});
    const res = await computeTier({ env: env({ TIER_OVERRIDES: `${SOL}:max` }), user: user(), readBalance: r.read, now: NOW });
    expect(res).toMatchObject({ tier: 'max', holding: null, holder: true, override: 'max' });
    expect(r.calls).toHaveLength(0);
  });

  it('reads TOKEN_ADDRESS on TOKEN_CHAIN for the matching wallet and maps the holding', async () => {
    const r = reader({ [SOL]: 300_000 });
    const res = await computeTier({ env: live(), user: user({ evmAddress: EVM }), readBalance: r.read, now: NOW });
    expect(res).toEqual({ tier: 'pro', holding: 300_000, holder: true, override: null, checkedAt: NOW, readAt: NOW, read: true, failed: false, expired: false });
    expect(r.calls).toEqual([{ chain: 'sol', token: MINT, owner: SOL }]);

    const evmToken = '0x1111111111111111111111111111111111111111';
    const r2 = reader({ [EVM]: 3_000_000 });
    const res2 = await computeTier({ env: live({ TOKEN_CHAIN: 'base', TOKEN_ADDRESS: evmToken }), user: user({ evmAddress: EVM }), readBalance: r2.read, now: NOW });
    expect(res2.tier).toBe('max');
    expect(r2.calls).toEqual([{ chain: 'base', token: evmToken, owner: EVM }]);
  });

  it('a small holding is a holder on the free tier; zero is not a holder', async () => {
    expect(await computeTier({ env: live(), user: user(), readBalance: reader({ [SOL]: 12.5 }).read, now: NOW })).toMatchObject({ tier: 'free', holder: true, holding: 12.5 });
    expect(await computeTier({ env: live(), user: user(), readBalance: reader({ [SOL]: 0 }).read, now: NOW })).toMatchObject({ tier: 'free', holder: false, holding: 0 });
  });

  it('uses the stored holding for an hour, re-reads after it (or when forced)', async () => {
    const r = reader({ [SOL]: 3_000_000 });
    const recent = user({ holding: '260000.5', tierCheckedAt: new Date(NOW.getTime() - TIER_CACHE_MS + 1000) });
    expect(await computeTier({ env: live(), user: recent, readBalance: r.read, now: NOW })).toMatchObject({ tier: 'pro', holding: 260000.5, read: false, checkedAt: recent.tierCheckedAt });
    expect(r.calls).toHaveLength(0);

    expect(await computeTier({ env: live(), user: recent, readBalance: r.read, now: NOW, force: true })).toMatchObject({ tier: 'max', holding: 3_000_000, read: true, checkedAt: NOW });

    const stale = user({ holding: 260000, tierCheckedAt: new Date(NOW.getTime() - TIER_CACHE_MS) });
    expect(await computeTier({ env: live(), user: stale, readBalance: r.read, now: NOW })).toMatchObject({ tier: 'max', read: true });
    expect(r.calls).toHaveLength(2);
  });

  it('a failed read keeps the last value and is retried after TIER_RETRY_MS', async () => {
    for (const failing of [null, 'throw'] as const) {
      const stale = user({ holding: 300_000, tierCheckedAt: new Date(NOW.getTime() - 2 * TIER_CACHE_MS) });
      const res = await computeTier({ env: live(), user: stale, readBalance: reader({ [SOL]: failing }).read, now: NOW });
      expect(res).toMatchObject({ tier: 'pro', holding: 300_000, holder: true, read: false, failed: true });
      // the cache runs out TIER_RETRY_MS from now
      expect(NOW.getTime() + TIER_RETRY_MS - res.checkedAt!.getTime()).toBe(TIER_CACHE_MS);
    }
    // never read before and the read fails: no holding, free
    const res = await computeTier({ env: live(), user: user(), readBalance: reader({ [SOL]: null }).read, now: NOW });
    expect(res).toMatchObject({ tier: 'free', holding: null, holder: false, failed: true });
    // a forced read failing while the cache is fresh keeps the fresher check time
    const fresh = user({ holding: 1, tierCheckedAt: new Date(NOW.getTime() - 1000) });
    expect((await computeTier({ env: live(), user: fresh, readBalance: reader({ [SOL]: null }).read, now: NOW, force: true })).checkedAt).toEqual(fresh.tierCheckedAt);
  });

  it('failed reads keep a paid tier only TIER_STALE_MAX_MS (24 h) after the last good read, then Free until one succeeds', async () => {
    const readAt = new Date(NOW.getTime() - TIER_STALE_MAX_MS + 60_000);
    const max = user({ holding: 3_000_000, tierReadAt: readAt, tierCheckedAt: new Date(NOW.getTime() - 2 * TIER_CACHE_MS) });
    // within the window: kept, and the last good read stays where it was
    const kept = await computeTier({ env: live(), user: max, readBalance: reader({ [SOL]: null }).read, now: NOW });
    expect(kept).toMatchObject({ tier: 'max', holding: 3_000_000, holder: true, failed: true, expired: false, readAt });
    expect(kept.checkedAt).toEqual(new Date(NOW.getTime() - TIER_CACHE_MS + TIER_RETRY_MS));

    // a day of failed reads later (each one moved tierCheckedAt on, tierReadAt stayed): dropped
    const later = new Date(NOW.getTime() + 60_000);
    const stale = { ...max, tierCheckedAt: kept.checkedAt };
    const dropped = await computeTier({ env: live(), user: stale, readBalance: reader({ [SOL]: 'throw' }).read, now: later, force: true });
    expect(dropped).toMatchObject({ tier: 'free', holding: null, holder: false, failed: true, expired: true, readAt });
    expect(tierUpdate(dropped)).toMatchObject({ tier: 'FREE', holding: null, tierReadAt: readAt });
    // still retried every TIER_RETRY_MS
    expect(later.getTime() + TIER_RETRY_MS - dropped.checkedAt!.getTime()).toBe(TIER_CACHE_MS);

    // the next failure: still Free, no second "expired"
    const after = await computeTier({ env: live(), user: { ...stale, holding: null, tierCheckedAt: dropped.checkedAt }, readBalance: reader({ [SOL]: null }).read, now: new Date(later.getTime() + TIER_RETRY_MS) });
    expect(after).toMatchObject({ tier: 'free', holding: null, holder: false, expired: false, readAt });

    // a read that succeeds again restores the tier
    const back = await computeTier({ env: live(), user: { ...stale, holding: null }, readBalance: reader({ [SOL]: 3_000_000 }).read, now: later, force: true });
    expect(back).toMatchObject({ tier: 'max', holding: 3_000_000, readAt: later, failed: false });

    // an override still applies while the holding is dropped
    expect(await computeTier({ env: live({ TIER_OVERRIDES: `${SOL}:pro` }), user: stale, readBalance: reader({ [SOL]: null }).read, now: later, force: true })).toMatchObject({
      tier: 'pro',
      holding: null,
      holder: true,
      expired: true,
    });
  });

  it('a holding stored without tierReadAt dates from tierCheckedAt: pinned on the first failure, so the retries cannot extend it', async () => {
    const lastGood = new Date(NOW.getTime() - 2 * TIER_CACHE_MS);
    const legacy = user({ holding: 3_000_000, tierCheckedAt: lastGood, tierReadAt: null });
    const first = await computeTier({ env: live(), user: legacy, readBalance: reader({ [SOL]: null }).read, now: NOW });
    expect(first).toMatchObject({ tier: 'max', failed: true, readAt: lastGood });
    expect(first.checkedAt!.getTime()).toBeGreaterThan(lastGood.getTime());

    // replay the stored columns through a day of failed reads, one every TIER_RETRY_MS
    let row = { ...legacy, ...tierUpdate(first) } as unknown as TierUser & { tier: string };
    let t = NOW.getTime();
    let res = first;
    while (t - lastGood.getTime() < TIER_STALE_MAX_MS + TIER_RETRY_MS) {
      t += TIER_RETRY_MS;
      res = await computeTier({ env: live(), user: row, readBalance: reader({ [SOL]: null }).read, now: new Date(t) });
      row = { ...row, ...tierUpdate(res) } as typeof row;
      if (res.expired) break;
    }
    expect(res).toMatchObject({ tier: 'free', holding: null, holder: false, expired: true, readAt: lastGood });
    expect(t - lastGood.getTime()).toBeGreaterThanOrEqual(TIER_STALE_MAX_MS);
    expect(t - lastGood.getTime()).toBeLessThan(TIER_STALE_MAX_MS + TIER_RETRY_MS);
  });

  it('no wallet on the token chain: holds 0 without a read', async () => {
    const r = reader({});
    const res = await computeTier({ env: live(), user: user({ solAddress: null, evmAddress: EVM }), readBalance: r.read, now: NOW });
    expect(res).toMatchObject({ tier: 'free', holding: 0, holder: false, checkedAt: NOW });
    expect(r.calls).toHaveLength(0);
  });

  it('an override never lowers a tier from holdings, and lifts a lower one', async () => {
    const e = live({ TIER_OVERRIDES: `${SOL}:pro` });
    expect(await computeTier({ env: e, user: user(), readBalance: reader({ [SOL]: 5_000_000 }).read, now: NOW })).toMatchObject({ tier: 'max', override: 'pro' });
    expect(await computeTier({ env: e, user: user(), readBalance: reader({ [SOL]: 0 }).read, now: NOW })).toMatchObject({ tier: 'pro', holder: true, holding: 0 });
    // the override sits on the EVM wallet while the token is on Solana
    const e2 = live({ TIER_OVERRIDES: `${EVM.toLowerCase()}:max` });
    expect(await computeTier({ env: e2, user: user({ evmAddress: EVM }), readBalance: reader({ [SOL]: 10 }).read, now: NOW })).toMatchObject({ tier: 'max', holding: 10 });
  });

  it('storedTier: what the row says without a read (holding only while the token is live, overrides on top)', () => {
    const row = user({ holding: '300000.5', tierCheckedAt: NOW, tierReadAt: new Date(NOW.getTime() - 1000) });
    expect(storedTier(live(), row)).toEqual({
      tier: 'pro', holding: 300000.5, holder: true, override: null, checkedAt: NOW, readAt: row.tierReadAt, read: false, failed: false, expired: false,
    });
    expect(storedTier(env({ TIER_OVERRIDES: `${SOL}:max` }), row)).toMatchObject({ tier: 'max', holding: null, holder: true, override: 'max' });
    expect(storedTier(env(), row)).toMatchObject({ tier: 'free', holding: null, holder: false });
  });

  it('tierUpdate maps to the User columns', () => {
    const readAt = new Date(NOW.getTime() - 1000);
    expect(tierUpdate({ tier: 'pro', holding: 12, holder: true, override: null, checkedAt: NOW, readAt, read: true, failed: false, expired: false })).toEqual({
      tier: 'PRO',
      holding: 12,
      tierCheckedAt: NOW,
      tierReadAt: readAt,
    });
  });
});
