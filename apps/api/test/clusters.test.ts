/** M4: CoinFactsDTO.clusters (WhaleFlow "deep holder clusters") for Pro/Max viewers only. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckReportDTO, CreateApiKeyResponse } from '@apecheck/core';
import { Client, EvmWallet, makeHarness, parseSse, resetState, seedCheck, seedCoinFacts, seedTarget, signedIn, type Harness } from './helpers';

const proW = new EvmWallet();
const maxW = new EvmWallet();
const CLUSTERS = [
  { label: 'Cluster A', wallets: 14, pct: 18.456, fundedFrom: 'Binance hot wallet' },
  { label: 'Cluster B', wallets: 6, pct: 4.2, fundedFrom: null },
];

describe('holder clusters on the report', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${proW.address}:pro,${maxW.address}:max` });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  async function coinCheck(clusters: unknown) {
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: `Mint${Date.now()}xxxxxxxxxxxxxxxxxxxxxxxxx`, ticker: 'ORBIT', name: '$ORBIT', domain: null, key: `ca:sol:${Math.random()}` });
    const c = await seedCheck(h.prisma, { targetId: t.id, coinScore: 44, coinBand: 'sketchy', narScore: 48, narBand: 'partly', evidence: clusters === undefined ? {} : { clusters } });
    await seedCoinFacts(h.prisma, c.id, { top10Pct: 31 });
    return c;
  }

  it('anonymous and Free viewers get clusters: null; Pro and Max (session or key) get them', async () => {
    const check = await coinCheck(CLUSTERS);
    const url = `/v1/checks/${check.shortId}`;
    const anon = await new Client(h.app).get(url);
    expect(anon.json<CheckReportDTO>().coin).toMatchObject({ verdict: 'SKETCHY', clusters: null });
    expect(anon.headers['cache-control']).toBeUndefined();

    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    expect((await free.get(url)).json<CheckReportDTO>().coin?.clusters).toBeNull();

    const expected = [
      { label: 'Cluster A', wallets: 14, pct: 18.46, fundedFrom: 'Binance hot wallet' },
      { label: 'Cluster B', wallets: 6, pct: 4.2, fundedFrom: null },
    ];
    const pro = new Client(h.app);
    await signedIn(pro, proW);
    const proRes = await pro.get(url);
    expect(proRes.json<CheckReportDTO>().coin?.clusters).toEqual(expected);
    // a viewer-specific copy is never cached
    expect(proRes.headers['cache-control']).toBe('private, no-store');

    const max = new Client(h.app);
    await signedIn(max, maxW);
    const key = (await max.post('/v1/keys', { name: 'clusters' })).json<CreateApiKeyResponse>().key;
    const keyed = await new Client(h.app).get(url, { authorization: `Bearer ${key}` });
    expect(keyed.json<CheckReportDTO>().coin?.clusters).toEqual(expected);

    // the SSE "done" report follows the same rule
    const sse = parseSse((await pro.get(`${url}/events`)).body);
    expect((sse.at(-1)?.data as CheckReportDTO).coin?.clusters).toEqual(expected);
    const anonSse = parseSse((await new Client(h.app).get(`${url}/events`)).body);
    expect((anonSse.at(-1)?.data as CheckReportDTO).coin?.clusters).toBeNull();
  });

  it('null without WhaleFlow clusters; malformed entries are dropped', async () => {
    const pro = new Client(h.app);
    await signedIn(pro, proW);
    const none = await coinCheck(undefined);
    expect((await pro.get(`/v1/checks/${none.shortId}`)).json<CheckReportDTO>().coin?.clusters).toBeNull();
    const empty = await coinCheck([]);
    expect((await pro.get(`/v1/checks/${empty.shortId}`)).json<CheckReportDTO>().coin?.clusters).toBeNull();
    const messy = await coinCheck([null, 'x', { label: '', wallets: 1, pct: 1 }, { label: 'ok', wallets: '3', pct: 1 }, { label: 'Real one', wallets: 3, pct: 2.5 }]);
    expect((await pro.get(`/v1/checks/${messy.shortId}`)).json<CheckReportDTO>().coin?.clusters).toEqual([{ label: 'Real one', wallets: 3, pct: 2.5, fundedFrom: null }]);
  });
});
