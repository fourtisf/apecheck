import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COIN_CALL_TIMEOUT_MS, COIN_SECTION_BUDGET_MS, coinFacts, contractAuthorityText, contractMintRenounced, solanaAuthorityText, type CoinFactsDeps,
} from '../src/coin-facts';
import { ZEPPELINOS_IMPL_SLOT } from '../src/abi';
import { createSources } from '../src/index';
import type { DexScreenerSource, DexTokenInfo, EvmSource, SolanaSource, TronSource } from '../src/types';
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
const after = <T>(ms: number, value: T) => new Promise<T>(res => setTimeout(() => res(value), ms));

function fakes(over: {
  dex?: Partial<DexScreenerSource>;
  evm?: Partial<EvmSource>;
  sol?: Partial<SolanaSource>;
  tron?: Partial<TronSource>;
  stubbed?: string[];
  timeoutMs?: number;
} = {}): CoinFactsDeps {
  return {
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
  it("every section comes from ApeCheck's own reads; bundle and LP have no source and stay null", async () => {
    const deps = fakes({
      sol: {
        largestHolders: async () => [{ owner: 'whale', account: 'a', amount: '1', pct: 33 }],
        mintInfo: async () => ({ exists: true, decimals: 6, supply: '42', mintAuthority: null, freezeAuthority: 'F1', token2022: false }),
      },
    });
    const f = await coinFacts(deps, 'sol', MINT);
    expect(f).toEqual({
      chain: 'sol',
      address: MINT,
      token: { name: 'Kairo', symbol: 'KAIRO', decimals: 6, supply: '42' },
      // Solana deployers are not looked up
      deployer: null,
      bundle: null,
      holders: { top10Pct: 33, devHoldPct: null, count: null, source: 'On-chain' },
      lp: null,
      authorities: { mintRenounced: true, freezeActive: true, owner: 'F1', text: 'Mint renounced, freeze active', source: 'On-chain' },
      market,
      stubbed: [],
      errors: [],
    });
    expect('clusters' in f).toBe(false);
  });

  it('Solana: top-10 from largest accounts, excluding the pair and AMM authorities; no deployer, so no dev share', async () => {
    const holders = [
      { owner: RAYDIUM_V4, account: 'acc0', amount: '0', pct: 40 },
      { owner: PAIR, account: 'acc1', amount: '0', pct: 10 },
      ...Array.from({ length: 12 }, (_, i) => ({ owner: i === 2 ? DEPLOYER : `holder${i}`, account: `acc${i + 2}`, amount: '0', pct: 3 - i * 0.1 })),
    ];
    const f = await coinFacts(fakes({ sol: { largestHolders: async () => holders } }), 'sol', MINT);
    // ten holders after exclusion: 3 + 2.9 + … + 2.1 (the deployer's wallet among them, but nothing says it is the deployer)
    expect(f.holders).toEqual({ top10Pct: 25.5, devHoldPct: null, count: null, source: 'On-chain' });
    expect(f.deployer).toBeNull();
    expect(f.authorities).toMatchObject({ mintRenounced: true, freezeActive: false, text: 'Renounced', source: 'On-chain' });
    expect(f.bundle).toBeNull();
    expect(f.lp).toBeNull();
  });

  it('Solana: stubbed keeps only stubs that matter to this chain; deployer not looked up; active mint authority', async () => {
    const f = await coinFacts(
      fakes({
        stubbed: ['x', 'etherscan', 'rpc-rh'],
        sol: {
          mintInfo: async () => ({ exists: true, decimals: 9, supply: '5', mintAuthority: 'MintAuth1', freezeAuthority: null, token2022: true }),
          largestHolders: async () => [{ owner: 'whale', account: 'a', amount: '1', pct: 60 }],
        },
      }),
      'sol',
      MINT,
    );
    expect(f.stubbed).toEqual([]);
    expect(f.deployer).toBeNull();
    expect(f.holders).toMatchObject({ top10Pct: 60, devHoldPct: null, source: 'On-chain' });
    expect(f.authorities).toEqual({ mintRenounced: false, freezeActive: false, owner: 'MintAuth1', text: 'Mint still active', source: 'On-chain' });
  });

  it('EVM: tokenBasics → authorities, the Etherscan creator → the deployer wallet (no launch record); no holders', async () => {
    const f = await coinFacts(
      fakes({
        stubbed: ['x', 'rpc-rh'],
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
    expect(f.deployer).toEqual({ address: '0xcreator', launched: null, dead: null, source: 'On-chain' });
    expect(f.authorities).toEqual({ mintRenounced: false, freezeActive: null, owner: '0xowner', text: 'Mint still active', source: 'On-chain' });
    expect(f.holders).toBeNull();
    expect(f.bundle).toBeNull();
    expect(f.lp).toBeNull();
    expect(f.stubbed).toEqual([]);
  });

  it('EVM without Etherscan: etherscan is listed as stubbed and deployer stays null', async () => {
    const f = await coinFacts(fakes({ stubbed: ['x', 'etherscan'], dex: { token: async () => null } }), 'eth', EVM_TOKEN);
    expect(f.stubbed).toEqual(['etherscan']);
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
    expect(f.deployer).toEqual({ address: 'TCreator', launched: null, dead: null, source: 'On-chain' });
    expect(f.holders).toBeNull();
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
    const sol = await coinFacts(fakes({ timeoutMs: 50, sol: { largestHolders: never } }), 'sol', MINT);
    expect(sol.errors).toEqual(['solana.largestHolders: timeout']);
    expect(sol.holders).toBeNull();
    expect(sol.authorities).toMatchObject({ mintRenounced: true, source: 'On-chain' });
    expect(sol.market).toEqual(market);

    const basics = { name: 'Thing', symbol: 'THING', decimals: 18, totalSupply: '1', owner: null, ownerRenounced: true, hasMintFunction: false };
    const evm = await coinFacts(fakes({ timeoutMs: 50, evm: { creator: never, tokenBasics: async () => basics } }), 'base', EVM_TOKEN);
    expect(evm.errors).toEqual(['evm.creator: timeout']);
    expect(evm.deployer).toBeNull();
    expect(evm.authorities).toMatchObject({ mintRenounced: true, text: 'Renounced' });
  });

  it('a call that makes several requests in a row gets one timeout per round, not one for all of them', async () => {
    // each answer is slower than one per-call timeout (50 ms) but within its rounds
    const basics = { name: 'Thing', symbol: 'THING', decimals: 18, totalSupply: '1', owner: null, ownerRenounced: null, hasMintFunction: null };
    const evm = await coinFacts(fakes({ timeoutMs: 50, evm: { tokenBasics: () => after(120, basics) } }), 'base', EVM_TOKEN);
    expect(evm.errors).toEqual([]);
    expect(evm.token).toMatchObject({ name: 'Thing' });

    const holders = [{ owner: 'whale', account: 'a', amount: '1', pct: 60 }];
    const sol = await coinFacts(fakes({ timeoutMs: 50, sol: { largestHolders: () => after(80, holders) } }), 'sol', MINT);
    expect(sol.errors).toEqual([]);
    expect(sol.holders).toMatchObject({ top10Pct: 60, source: 'On-chain' });

    const info = { name: 'T', symbol: 'TT', decimals: 6, totalSupply: '9', owner: null, creator: 'TCreator', hasMintFunction: null, ownerRenounced: null };
    const trx = await coinFacts(fakes({ timeoutMs: 50, tron: { tokenInfo: () => after(80, info) } }), 'trx', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(trx.errors).toEqual([]);
    expect(trx.deployer).toMatchObject({ address: 'TCreator' });

    // a single request still has one timeout
    const dex = await coinFacts(fakes({ timeoutMs: 50, dex: { token: () => after(80, market) } }), 'sol', MINT);
    expect(dex.errors).toEqual(['dexscreener.token: timeout']);
  });

  describe('default budgets', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('slow public RPCs: tokenBasics answering after two 8 s rounds is kept; nothing waits past the section budget', async () => {
      vi.useFakeTimers();
      const basics = { name: 'Thing', symbol: 'THING', decimals: 18, totalSupply: '1', owner: null, ownerRenounced: null, hasMintFunction: null };
      const slow = coinFacts(fakes({ evm: { tokenBasics: () => after(2 * COIN_CALL_TIMEOUT_MS - 1_000, basics) } }), 'base', EVM_TOKEN);
      await vi.advanceTimersByTimeAsync(2 * COIN_CALL_TIMEOUT_MS);
      const f = await slow;
      expect(f.errors).toEqual([]);
      expect(f.token).toMatchObject({ name: 'Thing' });

      let done = false;
      const hung = coinFacts(fakes({ evm: { tokenBasics: never } }), 'base', EVM_TOKEN).then(r => ((done = true), r));
      await vi.advanceTimersByTimeAsync(COIN_SECTION_BUDGET_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await hung).errors).toEqual(['evm.tokenBasics: timeout']);
    });

    it('the section budget stays well under the 30 s the worker waits for coinFacts', () => {
      // apps/worker/src/pipeline/evidence.ts coinFactsFor: within(sources.coinFacts(...), 30_000)
      expect(COIN_SECTION_BUDGET_MS).toBeGreaterThanOrEqual(2 * COIN_CALL_TIMEOUT_MS);
      expect(COIN_SECTION_BUDGET_MS).toBeLessThanOrEqual(30_000 - 8_000);
    });
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
    const f = await createSources(testEnv(), { http }).coinFacts('trx', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.errors.every(e => /^(dexscreener|tron)\.\w+: /.test(e))).toBe(true);
    expect(f.errors.some(e => e.startsWith('dexscreener.token: ') && e.includes('500'))).toBe(true);
    expect(f.deployer).toBeNull();
    expect(f.market).toBeNull();
  });
});

describe('createSources', () => {
  it('wires every adapter; stubbed() names the missing keys', () => {
    const s = createSources(testEnv(), { http: fakeHttp() });
    expect(s.stubbed()).toEqual(['x', 'etherscan']);
    expect(s.x.configured).toBe(false);
    expect('fourtis' in s).toBe(false);
    expect(s.dex.configured).toBe(true);
    // every EVM chain, Robinhood Chain on its public node
    expect(s.evm.chains()).toEqual(['base', 'eth', 'bnb', 'rh', 'arb']);
    const full = createSources(
      testEnv({ X_BEARER_TOKEN: 'b', ETHERSCAN_API_KEY: 'e' }),
      { http: fakeHttp() },
    );
    expect(full.stubbed()).toEqual([]);
  });

  it('builds a real Http client when none is injected', () => {
    const s = createSources(testEnv());
    expect(typeof s.http.request).toBe('function');
    expect(typeof s.http.json).toBe('function');
  });

  it('coinFacts end to end over fake HTTP (DexScreener + Solana RPC)', async () => {
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
    expect(f.stubbed).toEqual([]);
    expect(f.market?.pairAddress).toBe(PAIR);
    expect(f.holders).toEqual({ top10Pct: 10, devHoldPct: null, count: null, source: 'On-chain' });
    expect(f.authorities).toMatchObject({ mintRenounced: true, freezeActive: true, text: 'Mint renounced, freeze active' });
    expect(f.token).toEqual({ name: 'Kairo', symbol: 'KAIRO', decimals: 6, supply: '999987654321000' });
  });

  /** Base's Blockscout: the creator lookup without an Etherscan key */
  const BLOCKSCOUT_BASE = (url: URL) =>
    url.host === 'base.blockscout.com'
      ? { json: { status: '1', message: 'OK', result: [{ contractAddress: EVM_TOKEN, contractCreator: '0xC0FFEE0000000000000000000000000000000002', txHash: '0xbeef' }] } }
      : undefined;

  it('coinFacts end to end for an EVM coin (deployer from Blockscout without an Etherscan key)', async () => {
    const http = fakeHttp(
      url => (url.host === 'api.dexscreener.com' ? { json: [] } : undefined),
      BLOCKSCOUT_BASE,
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
    expect(f.deployer).toEqual({ address: '0xc0ffee0000000000000000000000000000000002', launched: null, dead: null, source: 'On-chain' });
    expect(f.stubbed).toEqual(['etherscan']);
    expect(f.errors).toEqual([]);
  });

  describe('EVM coin behind a proxy', () => {
    const IMPL = '0x1111111111111111111111111111111111111111';
    const OWNER = '0x9999999999999999999999999999999999999999';
    // a transparent proxy (Circle's FiatTokenProxy): admin(), implementation(), upgradeTo() and a DELEGATECALL fallback
    const proxyCode = '0x6080604052' + '63f851a440' + '635c60da1b' + '633659cfe6' + '00' + '5af43d6000803e3d6000f3';
    const node = (slots: Record<string, string>) =>
      fakeHttp(
        url => (url.host === 'api.dexscreener.com' ? { json: [] } : undefined),
        BLOCKSCOUT_BASE,
        rpcHandler('mainnet.base.org', {
          eth_getCode: p => ((p[0] as string).toLowerCase() === IMPL ? '0x6080604052' + '6318160ddd' + '63a9059cbb' + '6340c10f19' + '638da5cb5b' + '00' : proxyCode),
          eth_getStorageAt: p => slots[p[1] as string] ?? '0x' + '0'.repeat(64),
          eth_call: p => {
            const data = (p[0] as { data: string }).data;
            if (data === '0x313ce567') return encUint(6);
            if (data === '0x8da5cb5b') return encAddress(OWNER);
            return { error: { code: 3, message: 'execution reverted' } };
          },
        }),
      );

    it('USDC (implementation in the ZeppelinOS slot): "Mint still active", not "No mint function, owner active"', async () => {
      const f = await createSources(testEnv(), { http: node({ [ZEPPELINOS_IMPL_SLOT]: encAddress(IMPL) }) }).coinFacts('base', EVM_TOKEN);
      expect(f.errors).toEqual([]);
      expect(f.authorities).toEqual({ mintRenounced: false, freezeActive: null, owner: OWNER, text: 'Mint still active', source: 'On-chain' });
    });

    it('implementation in no known slot: mint renounced unknown', async () => {
      const f = await createSources(testEnv(), { http: node({}) }).coinFacts('base', EVM_TOKEN);
      expect(f.errors).toEqual([]);
      expect(f.authorities).toEqual({ mintRenounced: null, freezeActive: null, owner: OWNER, text: 'Owner active', source: 'On-chain' });
    });
  });

  it('EVM coin whose mint is gated by AccessControl (no owner()): authorities unknown, not "renounced"', async () => {
    // PUSH4 mint(address,uint256), hasRole, grantRole; owner() and getOwner() revert
    const http = fakeHttp(
      url => (url.host === 'api.dexscreener.com' ? { json: [] } : undefined),
      BLOCKSCOUT_BASE,
      rpcHandler('mainnet.base.org', {
        eth_getCode: () => '0x6080604052' + '6340c10f19' + '6391d14854' + '632f2ff15d' + '00',
        eth_getStorageAt: () => '0x' + '0'.repeat(64),
        eth_call: p => ((p[0] as { data: string }).data === '0x313ce567' ? encUint(18) : { error: { code: 3, message: 'execution reverted' } }),
      }),
    );
    const f = await createSources(testEnv(), { http }).coinFacts('base', EVM_TOKEN);
    expect(f.authorities).toEqual({ mintRenounced: null, freezeActive: null, owner: null, text: 'Mint function present, owner unknown', source: 'On-chain' });
    expect(f.errors).toEqual([]);
  });
});
