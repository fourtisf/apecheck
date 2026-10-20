import { describe, expect, it } from 'vitest';
import { createFourtis, FOURTIS_PATHS } from '../src/adapters/fourtis';
import { fakeHttp, testEnv } from './helpers';

const CFG = { FOURTIS_API_URL: 'https://internal.fourtis.example/api/', FOURTIS_API_KEY: 'ft-key' };
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('Fourtis adapter', () => {
  it('unconfigured → stub: null and no request', async () => {
    const http = fakeHttp();
    const f = createFourtis(testEnv({ FOURTIS_API_URL: 'https://x' }), http);
    expect(f.configured).toBe(false);
    expect(await f.devRadar('sol', MINT)).toBeNull();
    expect(await f.bundleScan('sol', MINT)).toBeNull();
    expect(await f.whaleFlow('sol', MINT)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('placeholder paths live in one place', () => {
    expect(FOURTIS_PATHS.devRadar('sol', MINT)).toBe(`/devradar/sol/${MINT}`);
    expect(FOURTIS_PATHS.bundleScan('base', '0xabc')).toBe('/bundlescan/base/0xabc');
    expect(FOURTIS_PATHS.whaleFlow('trx', 'TX')).toBe('/whaleflow/trx/TX');
  });

  it('devRadar: bearer auth, bare object, launches with chain keys', async () => {
    const http = fakeHttp(() => ({
      json: {
        deployer: '7xDeployer', fundedFrom: 'Binance hot wallet', launched: 12, dead: 10, firstSeen: '2025-01-02T00:00:00Z',
        launches: [{ address: 'A1', chain: 'sol', createdAt: '2025-05-01T00:00:00Z', dead: true }, { address: 'B2', chain: 'polygon', dead: false }],
      },
    }));
    const d = await createFourtis(testEnv(CFG), http).devRadar('sol', MINT);
    expect(http.calls[0].url).toBe(`https://internal.fourtis.example/api/devradar/sol/${MINT}`);
    expect(http.calls[0].req.headers?.authorization).toBe('Bearer ft-key');
    expect(d).toEqual({
      deployer: '7xDeployer', fundedFrom: 'Binance hot wallet', launched: 12, dead: 10, firstSeen: '2025-01-02T00:00:00Z',
      launches: [
        { address: 'A1', chain: 'sol', createdAt: '2025-05-01T00:00:00Z', dead: true },
        { address: 'B2', chain: null, createdAt: null, dead: false },
      ],
    });
  });

  it('bundleScan and whaleFlow accept { data: … } envelopes and numeric strings', async () => {
    const http = fakeHttp(url =>
      url.pathname.includes('/bundlescan/')
        ? { json: { data: { bundlePct: '23.5', wallets: 14, launchBlock: 301234567 } } }
        : { json: { data: { top10Pct: 31.2, devHoldPct: 4, holders: 1890, lp: { status: 'locked', lockedDays: '90' } } } },
    );
    const f = createFourtis(testEnv(CFG), http);
    expect(await f.bundleScan('sol', MINT)).toEqual({ bundlePct: 23.5, wallets: 14, launchBlock: '301234567' });
    expect(await f.whaleFlow('sol', MINT)).toEqual({ top10Pct: 31.2, devHoldPct: 4, holders: 1890, lp: { status: 'locked', lockedDays: 90 } });
  });

  it('invalid shapes are rejected (validated with zod) and recorded', async () => {
    const f = createFourtis(testEnv(CFG), fakeHttp(() => ({ json: { top10Pct: 140, devHoldPct: 2 } })));
    expect(await f.whaleFlow('sol', MINT)).toBeNull();
    expect(f.lastError).toMatch(/^fourtis\.whaleFlow: unexpected response shape/);
    const bad = createFourtis(testEnv(CFG), fakeHttp(() => ({ json: { deployer: 'x', launched: 2, dead: 5 } })));
    expect(await bad.devRadar('sol', MINT)).toBeNull();
    expect(bad.lastError).toMatch(/dead > launched/);
  });

  describe('whaleFlow holder clusters (M4, placeholder shape)', () => {
    const base = { top10Pct: 41, devHoldPct: 3, holders: 900 };

    it('maps [{ label, wallets, pct, fundedFrom }], largest first, numeric strings accepted', async () => {
      const f = createFourtis(
        testEnv(CFG),
        fakeHttp(() => ({
          json: {
            data: {
              ...base,
              clusters: [
                { label: 'Cluster B', wallets: '4', pct: '6.5', fundedFrom: null },
                { label: '  Cluster A  ', wallets: 12, pct: 18.2, fundedFrom: 'Binance hot wallet' },
                { label: 'Cluster C', wallets: 2, pct: 1 },
              ],
            },
          },
        })),
      );
      const w = await f.whaleFlow('sol', MINT);
      expect(w?.clusters).toEqual([
        { label: 'Cluster A', wallets: 12, pct: 18.2, fundedFrom: 'Binance hot wallet' },
        { label: 'Cluster B', wallets: 4, pct: 6.5, fundedFrom: null },
        { label: 'Cluster C', wallets: 2, pct: 1, fundedFrom: null },
      ]);
      expect(w).toMatchObject(base);
      expect(f.lastError).toBeNull();
    });

    it('none sent, an empty list or nothing usable → no clusters key (nothing stored, nothing invented)', async () => {
      for (const clusters of [undefined, null, []]) {
        const f = createFourtis(testEnv(CFG), fakeHttp(() => ({ json: { ...base, clusters } })));
        const w = await f.whaleFlow('sol', MINT);
        expect(w).toEqual({ ...base, lp: null });
        expect(w && 'clusters' in w).toBe(false);
        expect(f.lastError).toBeNull();
      }
    });

    it('odd items are left out and reported; the holder numbers and the other clusters stand', async () => {
      const f = createFourtis(
        testEnv(CFG),
        fakeHttp(() => ({
          json: {
            ...base,
            clusters: [
              { label: 'Good', wallets: 3, pct: 9 },
              { label: '', wallets: 3, pct: 9 },
              { label: 'No share', wallets: 3, pct: null },
              { label: 'Too big', wallets: 3, pct: 140 },
              { label: 'No wallets', wallets: 0, pct: 2 },
              'junk',
            ],
          },
        })),
      );
      const w = await f.whaleFlow('sol', MINT);
      expect(w?.top10Pct).toBe(41);
      expect(w?.clusters).toEqual([{ label: 'Good', wallets: 3, pct: 9, fundedFrom: null }]);
      expect(f.lastError).toBe('fourtis.whaleFlow: 5 holder cluster(s) with an unexpected shape left out');

      const notAList = createFourtis(testEnv(CFG), fakeHttp(() => ({ json: { ...base, clusters: { a: 1 } } })));
      const v = await notAList.whaleFlow('sol', MINT);
      expect(v).toEqual({ ...base, lp: null });
      expect(notAList.lastError).toMatch(/1 holder cluster\(s\) with an unexpected shape/);
    });

    it('keeps the 20 largest; long labels are clipped', async () => {
      const clusters = Array.from({ length: 25 }, (_, i) => ({ label: `C${i}`.padEnd(i === 24 ? 200 : 3, 'x'), wallets: 2, pct: i }));
      const w = await createFourtis(testEnv(CFG), fakeHttp(() => ({ json: { ...base, clusters } }))).whaleFlow('sol', MINT);
      expect(w?.clusters).toHaveLength(20);
      expect(w?.clusters?.[0].pct).toBe(24);
      expect(w?.clusters?.[0].label).toHaveLength(80);
      expect(w?.clusters?.[19].pct).toBe(5);
    });
  });

  it('404 = no data (null, not an error); 5xx = error', async () => {
    const nf = createFourtis(testEnv(CFG), fakeHttp(() => ({ status: 404, text: 'not found' })));
    expect(await nf.bundleScan('sol', MINT)).toBeNull();
    expect(nf.lastError).toBeNull();
    const down = createFourtis(testEnv(CFG), fakeHttp(() => ({ status: 502, text: 'bad gateway' })));
    expect(await down.bundleScan('sol', MINT)).toBeNull();
    expect(down.lastError).toBe('fourtis.bundleScan: HTTP 502 from internal.fourtis.example');
  });
});
