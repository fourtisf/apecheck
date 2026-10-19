import { describe, expect, it, vi } from 'vitest';
import { coinFacts, contractAuthorityText, contractMintRenounced, solanaAuthorityText, type CoinFactsDeps } from '../src/coin-facts';
import { createFourtis } from '../src/adapters/fourtis';
import { createSources } from '../src/index';
import type {
  DexScreenerSource, DexTokenInfo, EvmSource, FourtisSource, SolanaSource, TronSource,
} from '../src/types';
import { encAddress, encString, encUint, fakeHttp, fixture, rpcHandler, testEnv } from './helpers';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAIR = 'MASi45ub7Qe4ZE36UT5G6cU4ud8Fhhe4deS4F3cw9KTA';
const RAYDIUM_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const DEPLOYER = 'yNoVKf58ZTBqNAYT3j5qcdsyuMNmPfYetW5v6JXmj54o';
const EVM_TOKEN = '0x4200000000000000000000000000000000000abc';

const market: DexTokenInfo = {
  chain: 'sol', address: MINT, name: 'Kairo', symbol: 'KAIRO', priceUsd: 0.002, mc: 2_000_000, fdv: 2_100_000, liquidityUsd: 140_000,
  vol5m: 100, vol24h: 400_000, ch24: -12, pairAddress: PAIR, pairUrl: 'https://dexscreener.com/solana/x', dex: 'raydium',
  pairCreatedAt: '2025-10-08T00:00:00.000Z', websites: ['https://kairo.xyz'], socials: [], imageUrl: null,
};

const never = <T>() => new Promise<T>(() => {});

function fakes(over: {
  fourtis?: Partial<FourtisSource>;
  dex?: Partial<DexScreenerSource>;
  evm?: Partial<EvmSource>;
  sol?: Partial<SolanaSource>;
  tron?: Partial<TronSource>;
  stubbed?: string[];
  timeoutMs?: number;
} = {}): CoinFactsDeps {
  return {
    fourtis: { configured: false, devRadar: async () => null, bundleScan: async () => null, whaleFlow: async () => null, ...over.fourtis },
    dex: { configured: true, token: async () => market, tokens: async () => new Map(), search: async () => [], ...over.dex },
    evm: {
      chains: () => ['base'], detectChain: async () => null, getCode: async () => null, tokenBasics: async () => null,
      simulate: async () => ({ ok: false }), creator: async () => null, ...over.evm,
    },
    sol: {
      configured: true,
      mintInfo: async () => ({ exists: true, decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null, token2022: false }),
      largestHolders: async () => [],
      simulate: async () => ({ ok: false }),
      ...over.sol,
    },
    tron: { configured: true, tokenInfo: async () => null, ...over.tron },
    stubbed: over.stubbed ? () => over.stubbed! : undefined,
    timeoutMs: over.timeoutMs,
  };
}

describe('authority wording', () => {
  it('Solana: the prototype sentences', () => {
    expect(solanaAuthorityText(true, false)).toBe('Renounced');
    expect(solanaAuthorityText(true, true)).toBe('Mint renounced, freeze active');
    expect(solanaAuthorityText(false, true)).toBe('Mint still active');
    expect(solanaAuthorityText(false, false)).toBe('Mint still active');
  });
  it('EVM/Tron: mint renounced = no mint function OR owner renounced', () => {
    expect(contractMintRenounced(false, false)).toBe(true);
    expect(contractMintRenounced(true, true)).toBe(true);
    expect(contractMintRenounced(true, false)).toBe(false);
    expect(contractMintRenounced(true, null)).toBeNull();
    expect(contractMintRenounced(null, null)).toBeNull();
    expect(contractAuthorityText(false, true)).toBe('Renounced');
    expect(contractAuthorityText(true, false)).toBe('Mint still active');
    expect(contractAuthorityText(false, false)).toBe('No mint function, owner active');
    expect(contractAuthorityText(null, null)).toBe('Unknown');
  });
});

describe('coinFacts: precedence', () => {
  it('Fourtis values win over the on-chain fallbacks, each section names its source', async () => {
    const largestHolders = vi.fn(async () => [{ owner: 'x', account: 'y', amount: '1', pct: 90 }]);
    const deps = fakes({
      fourtis: {
        configured: true,
        devRadar: async () => ({ deployer: DEPLOYER, fundedFrom: 'Binance', launched: 9, dead: 7, firstSeen: '2025-01-01T00:00:00Z' }),
        bundleScan: async () => ({ bundlePct: 18.5, wallets: 11 }),
        whaleFlow: async () => ({ top10Pct: 33, devHoldPct: 2.5, holders: 4100, lp: { status: 'burned' } }),
      },
      sol: { largestHolders, mintInfo: async () => ({ exists: true, decimals: 6, supply: '42', mintAuthority: null, freezeAuthority: 'F1', token2022: false }) },
    });
    const f = await coinFacts(deps, 'sol', MINT);
    expect(f).toEqual({
      chain: 'sol',
      address: MINT,
      token: { name: 'Kairo', symbol: 'KAIRO', decimals: 6, supply: '42' },
      deployer: { address: DEPLOYER, fundedFrom: 'Binance', launched: 9, dead: 7, firstSeen: '2025-01-01T00:00:00Z', source: 'DevRadar' },
      bundle: { pct: 18.5, wallets: 11, source: 'BundleScan' },
      holders: { top10Pct: 33, devHoldPct: 2.5, count: 4100, source: 'WhaleFlow' },
      lp: { status: 'burned', lockedDays: null, source: 'WhaleFlow' },
      authorities: { mintRenounced: true, freezeActive: true, owner: 'F1', text: 'Mint renounced, freeze active', source: 'On-chain' },
      market,
      stubbed: [],
      errors: [],
    });
  });

  it('Solana fallback: top-10 from largest accounts, excluding the pair and AMM authorities; dev share when the deployer is known', async () => {
    const holders = [
      { owner: RAYDIUM_V4, account: 'acc0', amount: '0', pct: 40 },
      { owner: PAIR, account: 'acc1', amount: '0', pct: 10 },
      ...Array.from({ length: 12 }, (_, i) => ({ owner: i === 2 ? DEPLOYER : `holder${i}`, account: `acc${i + 2}`, amount: '0', pct: 3 - i * 0.1 })),
    ];
    const f = await coinFacts(
      fakes({
        fourtis: { configured: true, devRadar: async () => ({ deployer: DEPLOYER, fundedFrom: null, launched: 1, dead: 0, firstSeen: null }), whaleFlow: async () => null },
        sol: { largestHolders: async () => holders },
      }),
      'sol',
      MINT,
    );
    // ten holders after exclusion: 3 + 2.9 + … + 2.1
    expect(f.holders).toEqual({ top10Pct: 25.5, devHoldPct: 2.8, count: null, source: 'On-chain' });
    expect(f.authorities).toMatchObject({ mintRenounced: true, freezeActive: false, text: 'Renounced', source: 'On-chain' });
    expect(f.bundle).toBeNull();
    expect(f.lp).toBeNull();
  });

  it('without Fourtis: stubbed lists it, deployer unknown on Solana, active mint authority', async () => {
    const f = await coinFacts(
      fakes({
        stubbed: ['x', 'fourtis', 'etherscan', 'rpc-rh'],
        sol: {
          mintInfo: async () => ({ exists: true, decimals: 9, supply: '5', mintAuthority: 'MintAuth1', freezeAuthority: null, token2022: true }),
          largestHolders: async () => [{ owner: 'whale', account: 'a', amount: '1', pct: 60 }],
        },
      }),
      'sol',
      MINT,
    );
    expect(f.stubbed).toEqual(['fourtis']);
    expect(f.deployer).toBeNull();
    expect(f.holders).toMatchObject({ top10Pct: 60, devHoldPct: null, source: 'On-chain' });
    expect(f.authorities).toEqual({ mintRenounced: false, freezeActive: false, owner: 'MintAuth1', text: 'Mint still active', source: 'On-chain' });
  });

  it('EVM fallback: tokenBasics → authorities, creator → deployer with unknown launch history', async () => {
    const f = await coinFacts(
      fakes({
        stubbed: ['fourtis', 'rpc-rh'],
        dex: { token: async () => ({ ...market, chain: 'base', address: EVM_TOKEN }) },
        evm: {
          tokenBasics: async () => ({ name: 'Thing', symbol: 'THING', decimals: 18, totalSupply: '1000', owner: '0xowner', ownerRenounced: false, hasMintFunction: true }),
          creator: async () => ({ creator: '0xcreator', txHash: '0xtx', createdAt: '2025-10-10T00:00:00.000Z' }),
        },
      }),
      'base',
      EVM_TOKEN,
    );
    expect(f.token).toEqual({ name: 'Thing', symbol: 'THING', decimals: 18, supply: '1000' });
    expect(f.deployer).toEqual({ address: '0xcreator', fundedFrom: null, launched: null, dead: null, firstSeen: null, source: 'On-chain' });
    expect(f.authorities).toEqual({ mintRenounced: false, freezeActive: null, owner: '0xowner', text: 'Mint still active', source: 'On-chain' });
    expect(f.holders).toBeNull();
    expect(f.stubbed).toEqual(['fourtis']);
  });

  it('EVM without Etherscan: etherscan is listed as stubbed and deployer stays null', async () => {
    const f = await coinFacts(fakes({ stubbed: ['fourtis', 'etherscan'], dex: { token: async () => null } }), 'eth', EVM_TOKEN);
    expect(f.stubbed).toEqual(['fourtis', 'etherscan']);
    expect(f.deployer).toBeNull();
    expect(f.token).toBeNull();
    expect(f.market).toBeNull();
  });

  it('Tron fallback: creator and owner from tokenInfo', async () => {
    const f = await coinFacts(
      fakes({
        dex: { token: async () => null },
        tron: {
          tokenInfo: async () => ({ name: 'T', symbol: 'TT', decimals: 6, totalSupply: '9', owner: 'TOwner', creator: 'TCreator', hasMintFunction: false, ownerRenounced: false }),
        },
      }),
      'trx',
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    );
    expect(f.deployer).toMatchObject({ address: 'TCreator', launched: null, source: 'On-chain' });
    expect(f.authorities).toEqual({ mintRenounced: true, freezeActive: null, owner: 'TOwner', text: 'No mint function, owner active', source: 'On-chain' });
    expect(f.token).toEqual({ name: 'T', symbol: 'TT', decimals: 6, supply: '9' });
  });

  it('a missing Solana mint gives no authorities (not "renounced")', async () => {
    const f = await coinFacts(
      fakes({ sol: { mintInfo: async () => ({ exists: false, decimals: null, supply: null, mintAuthority: null, freezeAuthority: null, token2022: false }) } }),
      'sol',
      MINT,
    );
    expect(f.authorities).toBeNull();
    expect(f.token).toEqual({ name: 'Kairo', symbol: 'KAIRO', decimals: null, supply: null });
  });
});

describe('coinFacts: failures never throw', () => {
  it('slow calls time out per call and are listed; the rest still arrives', async () => {
    const f = await coinFacts(
      fakes({
        timeoutMs: 50,
        fourtis: { configured: true, devRadar: never, bundleScan: never, whaleFlow: async () => ({ top10Pct: 20, devHoldPct: 1, holders: null }) },
        sol: { largestHolders: never },
      }),
      'sol',
      MINT,
    );
    expect(f.errors).toEqual(['fourtis.devRadar: timeout', 'fourtis.bundleScan: timeout', 'solana.largestHolders: timeout']);
    expect(f.holders?.source).toBe('WhaleFlow');
    expect(f.market).toEqual(market);
  });

  it('throwing adapters are recorded, not propagated', async () => {
    const f = await coinFacts(
      fakes({
        dex: { token: async () => { throw new Error('socket hang up'); } },
        sol: { mintInfo: () => { throw new TypeError('boom'); } },
      }),
      'sol',
      MINT,
    );
    expect(f.errors).toEqual(['dexscreener.token: socket hang up', 'solana.mintInfo: boom']);
    expect(f.market).toBeNull();
    expect(f.authorities).toBeNull();
  });

  it('errors that adapters swallow (lastError) are collected per call', async () => {
    const http = fakeHttp(() => ({ status: 500, text: 'down' }));
    const fourtis = createFourtis(testEnv({ FOURTIS_API_URL: 'https://ft.example', FOURTIS_API_KEY: 'k' }), http);
    const f = await coinFacts({ ...fakes(), fourtis }, 'sol', MINT);
    expect(f.errors).toEqual([
      'fourtis.devRadar: HTTP 500 from ft.example',
      'fourtis.bundleScan: HTTP 500 from ft.example',
      'fourtis.whaleFlow: HTTP 500 from ft.example',
    ]);
    expect(f.deployer).toBeNull();
  });
});

describe('createSources', () => {
  it('wires every adapter; stubbed() names the missing keys', () => {
    const s = createSources(testEnv(), { http: fakeHttp() });
    expect(s.stubbed()).toEqual(['x', 'fourtis', 'etherscan', 'rpc-rh']);
    expect(s.x.configured).toBe(false);
    expect(s.fourtis.configured).toBe(false);
    expect(s.dex.configured).toBe(true);
    expect(s.evm.chains()).toEqual(['base', 'eth', 'bnb', 'arb']);
    const full = createSources(
      testEnv({ X_BEARER_TOKEN: 'b', FOURTIS_API_URL: 'https://f', FOURTIS_API_KEY: 'k', ETHERSCAN_API_KEY: 'e', RPC_ROBINHOOD: 'https://rh' }),
      { http: fakeHttp() },
    );
    expect(full.stubbed()).toEqual([]);
  });

  it('builds a real Http client when none is injected', () => {
    const s = createSources(testEnv());
    expect(typeof s.http.request).toBe('function');
    expect(typeof s.http.json).toBe('function');
  });

  it('coinFacts end to end over fake HTTP (DexScreener + Solana RPC, no Fourtis)', async () => {
    const http = fakeHttp(
      url => (url.host === 'api.dexscreener.com' ? { json: fixture('dexscreener-tokens-solana.json') } : undefined),
      rpcHandler('api.mainnet-beta.solana.com', {
        getAccountInfo: () => fixture('solana-mint-spl.json'),
        getTokenLargestAccounts: () => ({ value: [{ address: 'acc1', amount: '300' }, { address: 'acc2', amount: '100' }] }),
        getTokenSupply: () => ({ value: { amount: '1000' } }),
        getMultipleAccounts: () => ({
          value: [{ data: { parsed: { info: { owner: RAYDIUM_V4 } } } }, { data: { parsed: { info: { owner: 'someone' } } } }],
        }),
      }),
    );
    const f = await createSources(testEnv(), { http }).coinFacts('sol', MINT);
    expect(f.errors).toEqual([]);
    expect(f.stubbed).toEqual(['fourtis']);
    expect(f.market?.pairAddress).toBe(PAIR);
    expect(f.holders).toEqual({ top10Pct: 10, devHoldPct: null, count: null, source: 'On-chain' });
    expect(f.authorities).toMatchObject({ mintRenounced: true, freezeActive: true, text: 'Mint renounced, freeze active' });
    expect(f.token).toEqual({ name: 'Kairo', symbol: 'KAIRO', decimals: 6, supply: '999987654321000' });
  });

  it('coinFacts end to end for an EVM coin', async () => {
    const http = fakeHttp(
      url => (url.host === 'api.dexscreener.com' ? { json: [] } : undefined),
      rpcHandler('mainnet.base.org', {
        eth_getCode: () => '0x6080604052' + '6306fdde03' + '00',
        eth_getStorageAt: () => '0x' + '0'.repeat(64),
        eth_call: p => {
          const data = (p[0] as { data: string }).data;
          if (data === '0x06fdde03') return encString('Thing');
          if (data === '0x313ce567') return encUint(18);
          if (data === '0x8da5cb5b') return encAddress('0x0000000000000000000000000000000000000000');
          return { error: { code: 3, message: 'execution reverted' } };
        },
      }),
    );
    const f = await createSources(testEnv(), { http }).coinFacts('base', EVM_TOKEN);
    expect(f.token).toMatchObject({ name: 'Thing', decimals: 18 });
    expect(f.authorities).toMatchObject({ mintRenounced: true, text: 'Renounced', owner: '0x0000000000000000000000000000000000000000' });
    expect(f.deployer).toBeNull();
    expect(f.stubbed).toEqual(['fourtis', 'etherscan']);
    expect(f.errors).toEqual([]);
  });
});
