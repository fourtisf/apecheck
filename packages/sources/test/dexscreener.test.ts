import { describe, expect, it } from 'vitest';
import { createDexScreener, DEX_BATCH, dexChainName } from '../src/adapters/dexscreener';
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

  describe('a token listed only on chains ApeCheck has no reads for', () => {
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const pair = (chainId: string, liq: number, extra: Record<string, unknown> = {}) => ({
      chainId, dexId: 'shadow', url: `https://dexscreener.com/${chainId}/0xpair${liq}`, pairAddress: `0xpair${liq}`,
      baseToken: { address: '0x17C63A297A76BED7E96A96BCF5F566DE1EFDD1FC', name: 'Esco', symbol: 'ESCO' }, priceUsd: '0.02', liquidity: { usd: liq }, ...extra,
    });
    const sonicOnly = {
      schemaVersion: '1.0.0',
      pairs: [
        pair('sonic', 500),
        pair('sonic', 42_000, { info: { imageUrl: 'https://dd.dexscreener.com/esco.png', websites: [{ url: 'https://esco.example' }], socials: [{ type: 'twitter', url: 'https://x.com/escofinance' }, { platform: 'telegram', handle: 'escofi' }] } }),
        // the token as the quote side of someone else's pair is not its listing
        { ...pair('base', 9_000_000), baseToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' }, quoteToken: { address: SONIC } },
      ],
    };

    it('token(null, address) still finds nothing: the check never invents a coin on an unsupported chain', async () => {
      const dex = createDexScreener(testEnv(), fakeHttp(() => ({ json: sonicOnly })));
      expect(await dex.token(null, SONIC)).toBeNull();
    });

    it('otherChain(address): the most liquid pair there, its chain named, links from its token info, no market numbers', async () => {
      const http = fakeHttp(url => (url.pathname === `/latest/dex/tokens/${SONIC}` ? { json: sonicOnly } : undefined));
      const t = await createDexScreener(testEnv(), http).otherChain(SONIC);
      expect(http.calls).toHaveLength(1);
      expect(t).toEqual({
        dexChain: 'sonic',
        chainName: 'Sonic',
        address: '0x17C63A297A76BED7E96A96BCF5F566DE1EFDD1FC',
        name: 'Esco',
        symbol: 'ESCO',
        pairUrl: 'https://dexscreener.com/sonic/0xpair42000',
        websites: ['https://esco.example'],
        socials: [
          { type: 'twitter', url: 'https://x.com/escofinance' },
          { type: 'telegram', url: 'https://t.me/escofi' },
        ],
        imageUrl: 'https://dd.dexscreener.com/esco.png',
      });
    });

    it('otherChain(address) is null when a supported chain lists the token too (token() answers then), or nothing does', async () => {
      const both = createDexScreener(testEnv(), fakeHttp(() => ({ json: fixture('dexscreener-latest-evm.json') })));
      expect(await both.otherChain(BASE_TOKEN)).toBeNull();
      const none = createDexScreener(testEnv(), fakeHttp(() => ({ json: { schemaVersion: '1.0.0', pairs: null } })));
      expect(await none.otherChain(SONIC)).toBeNull();
      expect(none.lastError).toBeNull();
    });

    it('otherChain(address): an HTTP error is null with the reason (also reported to the capture scope)', async () => {
      const dex = createDexScreener(testEnv(), fakeHttp(() => ({ status: 503, text: 'down' })));
      const { value, errors } = await captureErrors(() => dex.otherChain(SONIC));
      expect(value).toBeNull();
      expect(errors).toEqual(['dexscreener.otherChain: HTTP 503 from api.dexscreener.com']);
    });

    it('dexChainName: known ids by name, other plain ids title-cased, anything odd is "another chain"', () => {
      expect(['sonic', 'polygon', 'avalanche', 'hyperevm', 'new-chain', 'ab', '__proto__', 'constructor', 'Sonic<script>', ''].map(dexChainName)).toEqual([
        'Sonic', 'Polygon', 'Avalanche', 'HyperEVM', 'New Chain', 'Ab', 'another chain', 'Constructor', 'another chain', 'another chain',
      ]);
    });
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
