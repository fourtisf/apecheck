import { describe, expect, it } from 'vitest';
import { createDexScreener, DEX_BATCH } from '../src/adapters/dexscreener';
import { captureErrors } from '../src/util';
import { fakeHttp, fixture, testEnv } from './helpers';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BASE_TOKEN = '0x4200000000000000000000000000000000000abc';

describe('DexScreener adapter', () => {
  it('token(chain, address): /tokens/v1/{dexChain}/{address}, most liquid base pair, full mapping', async () => {
    const http = fakeHttp(url => (url.pathname === `/tokens/v1/solana/${MINT}` ? { json: fixture('dexscreener-tokens-solana.json') } : undefined));
    const dex = createDexScreener(testEnv(), http);
    const t = await dex.token('sol', MINT);
    expect(http.calls[0].url).toBe(`https://api.dexscreener.com/tokens/v1/solana/${MINT}`);
    expect(t).toEqual({
      chain: 'sol',
      address: MINT,
      name: 'Kairo',
      symbol: 'KAIRO',
      priceUsd: 0.002345,
      mc: 2101000,
      fdv: 2345000,
      liquidityUsd: 145678.9,
      vol5m: 1520.25,
      vol24h: 412345.67,
      ch24: -12.34,
      pairAddress: 'MASi45ub7Qe4ZE36UT5G6cU4ud8Fhhe4deS4F3cw9KTA',
      pairUrl: 'https://dexscreener.com/solana/masi45ub7qe4ze36ut5g6cu4ud8fhhe4des4f3cw9kta',
      dex: 'raydium',
      pairCreatedAt: '2025-10-08T00:00:00.000Z',
      websites: ['https://kairo.xyz', 'https://docs.kairo.xyz'],
      socials: [
        { type: 'twitter', url: 'https://x.com/kairolabs' },
        { type: 'telegram', url: 'https://t.me/kairolabs' },
      ],
      imageUrl: `https://dd.dexscreener.com/ds-data/tokens/solana/${MINT}.png`,
    });
  });

  it('token(null, address): /latest/dex/tokens, chain from the pair, unsupported chains ignored, mc falls back to fdv', async () => {
    const http = fakeHttp(url => (url.pathname === `/latest/dex/tokens/${BASE_TOKEN}` ? { json: fixture('dexscreener-latest-evm.json') } : undefined));
    const t = await createDexScreener(testEnv(), http).token(null, BASE_TOKEN);
    expect(t).toMatchObject({
      chain: 'base',
      address: '0x4200000000000000000000000000000000000ABC',
      symbol: 'THING',
      mc: 1230000,
      fdv: 1230000,
      liquidityUsd: 88000,
      vol5m: 0,
      ch24: 5.5,
      dex: 'aerodrome',
      pairCreatedAt: '2025-10-10T00:00:00.000Z',
      websites: [],
      socials: [{ type: 'twitter', url: 'https://x.com/thingonbase' }],
      imageUrl: null,
    });
  });

  it('honours DEXSCREENER_BASE', async () => {
    const http = fakeHttp(() => ({ json: [] }));
    await createDexScreener(testEnv({ DEXSCREENER_BASE: 'http://127.0.0.1:9999/' }), http).token('base', BASE_TOKEN);
    expect(http.calls[0].url).toBe(`http://127.0.0.1:9999/tokens/v1/base/${BASE_TOKEN}`);
  });

  it('no pairs → null, without an error', async () => {
    const dex = createDexScreener(testEnv(), fakeHttp(() => ({ json: { schemaVersion: '1.0.0', pairs: null } })));
    expect(await dex.token(null, MINT)).toBeNull();
    expect(dex.lastError).toBeNull();
  });

  it('HTTP errors resolve null and set lastError (also reported to the capture scope)', async () => {
    const dex = createDexScreener(testEnv(), fakeHttp(() => ({ status: 429, text: 'slow down' })));
    const { value, errors } = await captureErrors(() => dex.token('sol', MINT));
    expect(value).toBeNull();
    expect(dex.lastError).toBe('dexscreener.token: HTTP 429 from api.dexscreener.com');
    expect(errors).toEqual(['dexscreener.token: HTTP 429 from api.dexscreener.com']);
  });

  it('tokens(): batches of 30 addresses, map keyed by lowercase address', async () => {
    const addrs = Array.from({ length: 65 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, 'A'));
    const http = fakeHttp(url => {
      const list = url.pathname.split('/').pop()!.split(',');
      return {
        json: list.map((a, i) => ({
          chainId: 'base', dexId: 'uniswap', pairAddress: `0xpair${i}`, url: 'https://dexscreener.com/base/x',
          baseToken: { address: a, name: `T${a.slice(-3)}`, symbol: 'T' }, priceUsd: '1.5', liquidity: { usd: 100 },
        })),
      };
    });
    const map = await createDexScreener(testEnv(), http).tokens('base', [...addrs, addrs[0].toLowerCase()]);
    expect(DEX_BATCH).toBe(30);
    expect(http.calls.map(c => c.url.split('/').pop()!.split(',').length)).toEqual([30, 30, 5]);
    expect(http.calls[0].url).toMatch(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/base\//);
    expect(map.size).toBe(65);
    expect(map.get(addrs[7].toLowerCase())?.priceUsd).toBe(1.5);
  });

  it('tokens(): a failing batch does not drop the others', async () => {
    let n = 0;
    const http = fakeHttp(url => {
      n++;
      if (n === 1) return { status: 500, text: 'down' };
      const list = url.pathname.split('/').pop()!.split(',');
      return { json: list.map(a => ({ chainId: 'solana', baseToken: { address: a }, priceUsd: '2' })) };
    });
    const addrs = Array.from({ length: 31 }, (_, i) => `MintAddr${i}`);
    const dex = createDexScreener(testEnv(), http);
    const map = await dex.tokens('sol', addrs);
    expect(map.size).toBe(1);
    expect(dex.lastError).toMatch(/^dexscreener\.tokens: HTTP 500/);
  });

  it('search(): one entry per token (its most liquid pair), sorted by liquidity, unsupported chains dropped', async () => {
    const http = fakeHttp(url => (url.pathname === '/latest/dex/search' && url.searchParams.get('q') === 'kairo labs' ? { json: fixture('dexscreener-search.json') } : undefined));
    const res = await createDexScreener(testEnv(), http).search('kairo labs');
    expect(http.calls[0].url).toBe('https://api.dexscreener.com/latest/dex/search?q=kairo%20labs');
    expect(res.map(r => [r.chain, r.address, r.liquidityUsd])).toEqual([
      ['sol', MINT, 145678.9],
      ['base', '0x00000000000000000000000000000000000000a1', 1000],
    ]);
  });
});
