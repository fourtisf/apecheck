/**
 * Stage D for coins: Fourtis services first, public on-chain / DexScreener fallbacks second.
 * Raw facts only; the worker turns them into ok/warn/fail with the thresholds in @apecheck/core.
 */
import { CHAINS, type ChainKey } from '@apecheck/core';
import type {
  CoinRawFacts, DexScreenerSource, EvmSource, EvmTokenBasics, FourtisSource, SolMintInfo, SolanaSource, TronSource,
} from './types';
import { TimeoutError, captureErrors, errMsg, uniq, withTimeout } from './util';

export const COIN_CALL_TIMEOUT_MS = 8_000;

/**
 * Owners of AMM pool vaults on Solana. Their token accounts hold the pool side of the liquidity,
 * not a holder's bag, so they are left out of the top-10 share (pools owned by the pair account itself
 * are caught by the DexScreener pair address).
 */
export const SOLANA_AMM_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', // Raydium LaunchLab
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', // Meteora DAMM v2
  '1nc1nerator11111111111111111111111111111111', // incinerator: burned, not held
]);

export interface CoinFactsDeps {
  fourtis: FourtisSource;
  dex: DexScreenerSource;
  evm: EvmSource;
  sol: SolanaSource;
  tron: TronSource;
  /** Sources.stubbed(); entries relevant to coins are copied into the result */
  stubbed?: () => string[];
  /** per-call timeout (default 8 s) */
  timeoutMs?: number;
}

/** "Renounced" / "Mint renounced, freeze active" / "Mint still active" (the prototype's wording). */
export function solanaAuthorityText(mintRenounced: boolean, freezeActive: boolean): string {
  if (!mintRenounced) return 'Mint still active';
  return freezeActive ? 'Mint renounced, freeze active' : 'Renounced';
}

/** EVM/Tron: no freeze authority; the mint risk is a mint function an owner can still call. */
export function contractAuthorityText(hasMint: boolean | null, ownerRenounced: boolean | null): string {
  if (ownerRenounced === true) return hasMint === true ? 'Owner renounced, mint function present' : 'Renounced';
  if (hasMint === false) return ownerRenounced === false ? 'No mint function, owner active' : 'No mint function';
  if (hasMint === true) return ownerRenounced === false ? 'Mint still active' : 'Mint function present, owner unknown';
  return ownerRenounced === false ? 'Owner active' : 'Unknown';
}

/** spec rule: mint renounced = no mint function OR owner renounced; null when neither is known */
export function contractMintRenounced(hasMint: boolean | null | undefined, ownerRenounced: boolean | null | undefined): boolean | null {
  if (hasMint === false || ownerRenounced === true) return true;
  if (hasMint === true && ownerRenounced === false) return false;
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function solanaHolders(
  holders: { owner: string | null; account: string; pct: number }[],
  pairAddress: string | null,
  deployer: string | null,
): { top10Pct: number; devHoldPct: number | null } | null {
  const exclude = new Set(SOLANA_AMM_AUTHORITIES);
  if (pairAddress) exclude.add(pairAddress);
  const kept = holders.filter(h => !(h.owner && exclude.has(h.owner)));
  if (!kept.length) return null;
  const top10Pct = round2(kept.slice(0, 10).reduce((s, h) => s + h.pct, 0));
  // the largest-accounts list only covers the top 20, so a deployer outside it is unknown, not 0
  const dev = deployer ? kept.filter(h => h.owner === deployer) : [];
  return { top10Pct, devHoldPct: dev.length ? round2(dev.reduce((s, h) => s + h.pct, 0)) : null };
}

function emptyFacts(chain: ChainKey, address: string): CoinRawFacts {
  return {
    chain, address, token: null, deployer: null, bundle: null, holders: null, lp: null, authorities: null,
    market: null, stubbed: [], errors: [],
  };
}

export async function coinFacts(deps: CoinFactsDeps, chain: ChainKey, address: string): Promise<CoinRawFacts> {
  const timeoutMs = deps.timeoutMs ?? COIN_CALL_TIMEOUT_MS;
  // one slot per call so the error list keeps the call order whatever finishes first
  const slots: string[][] = [];

  /** run one adapter call with a timeout; never throws; adapter-reported errors are collected */
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    const slot: string[] = [];
    slots.push(slot);
    try {
      const { value, errors: reported } = await captureErrors(() => withTimeout(Promise.resolve().then(fn), timeoutMs, label));
      slot.push(...reported);
      return value ?? null;
    } catch (e) {
      slot.push(e instanceof TimeoutError ? `${label}: timeout` : `${label}: ${errMsg(e)}`);
      return null;
    }
  }
  const errors = () => uniq(slots.flat());

  try {
    const family = CHAINS[chain].family;
    const fourtisOn = deps.fourtis.configured;
    const skip = Promise.resolve(null);

    const [dev, bundle, whale, market, solMint, solTop, evmBasics, evmCreator, tronInfo] = await Promise.all([
      fourtisOn ? run('fourtis.devRadar', () => deps.fourtis.devRadar(chain, address)) : skip,
      fourtisOn ? run('fourtis.bundleScan', () => deps.fourtis.bundleScan(chain, address)) : skip,
      fourtisOn ? run('fourtis.whaleFlow', () => deps.fourtis.whaleFlow(chain, address)) : skip,
      run('dexscreener.token', () => deps.dex.token(chain, address)),
      family === 'sol' ? run<SolMintInfo | null>('solana.mintInfo', () => deps.sol.mintInfo(address)) : skip,
      family === 'sol' ? run('solana.largestHolders', () => deps.sol.largestHolders(address)) : skip,
      family === 'evm' ? run<EvmTokenBasics | null>('evm.tokenBasics', () => deps.evm.tokenBasics(chain, address)) : skip,
      family === 'evm' ? run('evm.creator', () => deps.evm.creator(chain, address)) : skip,
      family === 'trx' ? run('tron.tokenInfo', () => deps.tron.tokenInfo(address)) : skip,
    ]);

    const facts = emptyFacts(chain, address);
    facts.market = market;

    if (solMint?.exists) {
      facts.token = { name: market?.name ?? null, symbol: market?.symbol ?? null, decimals: solMint.decimals, supply: solMint.supply };
    } else if (evmBasics) {
      facts.token = {
        name: evmBasics.name ?? market?.name ?? null,
        symbol: evmBasics.symbol ?? market?.symbol ?? null,
        decimals: evmBasics.decimals,
        supply: evmBasics.totalSupply,
      };
    } else if (tronInfo) {
      facts.token = {
        name: tronInfo.name ?? market?.name ?? null,
        symbol: tronInfo.symbol ?? market?.symbol ?? null,
        decimals: tronInfo.decimals,
        supply: tronInfo.totalSupply,
      };
    } else if (market) {
      facts.token = { name: market.name, symbol: market.symbol, decimals: null, supply: null };
    }

    if (dev) {
      facts.deployer = {
        address: dev.deployer, fundedFrom: dev.fundedFrom, launched: dev.launched, dead: dev.dead, firstSeen: dev.firstSeen, source: 'DevRadar',
      };
    } else if (evmCreator) {
      facts.deployer = { address: evmCreator.creator, fundedFrom: null, launched: null, dead: null, firstSeen: null, source: 'On-chain' };
    } else if (tronInfo?.creator) {
      facts.deployer = { address: tronInfo.creator, fundedFrom: null, launched: null, dead: null, firstSeen: null, source: 'On-chain' };
    }

    if (bundle) facts.bundle = { pct: bundle.bundlePct, wallets: bundle.wallets, source: 'BundleScan' };

    if (whale) {
      facts.holders = { top10Pct: whale.top10Pct, devHoldPct: whale.devHoldPct, count: whale.holders, source: 'WhaleFlow' };
    } else if (solTop?.length) {
      const h = solanaHolders(solTop, market?.pairAddress ?? null, facts.deployer?.address ?? null);
      if (h) facts.holders = { top10Pct: h.top10Pct, devHoldPct: h.devHoldPct, count: null, source: 'On-chain' };
    }

    if (whale?.lp) facts.lp = { status: whale.lp.status, lockedDays: whale.lp.lockedDays ?? null, source: 'WhaleFlow' };
    // M4: holder clusters only ever come from WhaleFlow (no public fallback): none → no key, nothing stored
    if (whale?.clusters?.length) facts.clusters = whale.clusters.map(c => ({ label: c.label, wallets: c.wallets, pct: c.pct, fundedFrom: c.fundedFrom ?? null }));

    if (solMint?.exists) {
      const mintRenounced = solMint.mintAuthority == null;
      const freezeActive = solMint.freezeAuthority != null;
      facts.authorities = {
        mintRenounced,
        freezeActive,
        owner: solMint.mintAuthority ?? solMint.freezeAuthority ?? null,
        text: solanaAuthorityText(mintRenounced, freezeActive),
        source: 'On-chain',
      };
    } else if (evmBasics || tronInfo) {
      const hasMint = evmBasics ? evmBasics.hasMintFunction : tronInfo?.hasMintFunction ?? null;
      const renounced = evmBasics ? evmBasics.ownerRenounced : tronInfo?.ownerRenounced ?? null;
      facts.authorities = {
        mintRenounced: contractMintRenounced(hasMint, renounced),
        freezeActive: null,
        owner: evmBasics ? evmBasics.owner : tronInfo?.owner ?? null,
        text: contractAuthorityText(hasMint ?? null, renounced ?? null),
        source: 'On-chain',
      };
    }

    const allStubs = deps.stubbed?.() ?? (fourtisOn ? [] : ['fourtis']);
    facts.stubbed = allStubs.filter(
      s => s === 'fourtis' || (family === 'evm' && s === 'etherscan') || (s === `rpc-${chain}`),
    );
    facts.errors = errors();
    return facts;
  } catch (e) {
    const facts = emptyFacts(chain, address);
    facts.errors = uniq([...errors(), `coinFacts: ${errMsg(e)}`]);
    return facts;
  }
}
