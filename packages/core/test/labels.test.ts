import { describe, expect, it } from 'vitest';
import { otherChainOf } from '../src/evidence';
import { currentStubs, deployerHistoryLine, displayStep, otherChainCoinText, scrubRetired } from '../src/labels';

describe('displayStep: steps stored before ApeCheck dropped its third-party coin sources', () => {
  it('reads their "unavailable" lines as "not checked", without the retired source tag, keeping the suffix', () => {
    expect(displayStep({ text: 'DevRadar unavailable, deployer history unknown (0xAbC…Ef02)', source: 'DevRadar' })).toEqual({
      text: 'Deployer history: not checked (0xAbC…Ef02)',
      source: null,
    });
    expect(displayStep({ text: 'DevRadar unavailable, deployer history unknown', source: 'DevRadar' })).toEqual({
      text: 'Deployer history: not checked',
      source: null,
    });
    expect(displayStep({ text: 'BundleScan unavailable, bundle share unknown', source: 'BundleScan' })).toEqual({ text: 'Bundle share: not checked', source: null });
    expect(displayStep({ text: 'WhaleFlow unavailable, holder share unknown', source: 'WhaleFlow' })).toEqual({ text: 'Holder share: not checked', source: null });
    expect(displayStep({ text: 'WhaleFlow unavailable, holder share unknown (Solana RPC unavailable)', source: 'WhaleFlow' })).toEqual({
      text: 'Holder share: not checked (Solana RPC unavailable)',
      source: null,
    });
    expect(displayStep({ text: 'Liquidity locked 30 days; holder share unknown (WhaleFlow unavailable)', source: 'WhaleFlow' })).toEqual({
      text: 'Liquidity locked 30 days; holder share: not checked',
      source: null,
    });
  });

  it('keeps a result line one of them wrote, only without the tag; other fields stay', () => {
    expect(displayStep({ idx: 4, text: 'Launch: 12.4% of supply bought by 7 bundled wallets', source: 'BundleScan' })).toEqual({
      idx: 4,
      text: 'Launch: 12.4% of supply bought by 7 bundled wallets',
      source: null,
    });
    expect(displayStep({ text: 'Deployer: 3 earlier tokens, 2 dead', source: 'DevRadar' })).toEqual({ text: 'Deployer: 3 earlier tokens, 2 dead', source: null });
  });

  it('leaves every other step alone (same object)', () => {
    for (const source of ['GitHub', 'X', 'DexScreener', 'On-chain', 'ApeCheck', null, undefined]) {
      const s = { text: 'DevRadar unavailable, deployer history unknown', source, idx: 3 };
      expect(displayStep(s)).toBe(s);
    }
  });
});

describe('deployerHistoryLine', () => {
  const c = (ticker: string | null, name = ticker ? `$${ticker}` : 'orbit.xyz') => ({ ticker, name });
  it('no other coin', () => {
    expect(deployerHistoryLine({ total: 0, coins: [] })).toBe('no earlier launches seen by ApeCheck');
  });
  it('one and two coins', () => {
    expect(deployerHistoryLine({ total: 1, coins: [c('FOO')] })).toBe('1 other coin from this wallet checked by ApeCheck, $FOO');
    expect(deployerHistoryLine({ total: 2, coins: [c('FOO'), c('BAR')] })).toBe('2 other coins from this wallet checked by ApeCheck, $FOO and $BAR');
    expect(deployerHistoryLine({ total: 1, coins: [c(null)] })).toBe('1 other coin from this wallet checked by ApeCheck, orbit.xyz');
  });
  it('three names at most, then "and N more" (N from the total, not the rows)', () => {
    expect(deployerHistoryLine({ total: 3, coins: [c('A'), c('B'), c('C')] })).toBe('3 other coins from this wallet checked by ApeCheck, $A, $B and $C');
    expect(deployerHistoryLine({ total: 4, coins: [c('A'), c('B'), c('C'), c('D')] })).toBe(
      '4 other coins from this wallet checked by ApeCheck, $A, $B, $C and 1 more',
    );
    expect(deployerHistoryLine({ total: 12, coins: [c('A'), c('B')] })).toBe('12 other coins from this wallet checked by ApeCheck, $A, $B and 10 more');
    expect(deployerHistoryLine({ total: 5, coins: [] })).toBe('5 other coins from this wallet checked by ApeCheck');
  });
});

describe('free text and stub lists stored about old checks', () => {
  it('scrubRetired names no retired service: a neutral phrase, capitalised at the start of a sentence', () => {
    expect(scrubRetired('DevRadar was unavailable, so the deployer history is unknown.')).toBe('The deployer lookup was unavailable, so the deployer history is unknown.');
    expect(scrubRetired('Holders per WhaleFlow look concentrated. BundleScan saw 7 wallets.')).toBe(
      'Holders per the holder lookup look concentrated. The bundle lookup saw 7 wallets.',
    );
    expect(scrubRetired('fourtis data missing')).toBe('Coin data missing');
    expect(scrubRetired('Per Fourtis, 3 wallets.')).toBe('Per the coin data lookup, 3 wallets.');
    expect(scrubRetired('The app loads.')).toBe('The app loads.');
    expect(scrubRetired(null)).toBeNull();
    expect(scrubRetired('')).toBe('');
  });
  it('currentStubs drops the retired adapter only', () => {
    expect(currentStubs(['x', 'fourtis', 'etherscan', 'ai'])).toEqual(['x', 'etherscan', 'ai']);
    expect(currentStubs(undefined)).toEqual([]);
  });
});

describe("a coin on a chain ApeCheck can't read (Check.evidence.otherChain)", () => {
  const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
  it('reads what the worker stored, and nothing that does not hold up', () => {
    expect(otherChainOf({ otherChain: { chain: 'Sonic', address: SONIC, site: 'esco.example' } })).toEqual({ chain: 'Sonic', address: SONIC, site: 'esco.example' });
    expect(otherChainOf({ otherChain: { chain: 'Sonic', address: SONIC.toUpperCase().replace('0X', '0x') } })).toEqual({ chain: 'Sonic', address: SONIC, site: null });
    expect(otherChainOf({ otherChain: { chain: 'Sonic', address: SONIC, site: 'https://evil.example/x' } })?.site).toBeNull();
    for (const ev of [null, undefined, [], 'x', {}, { otherChain: null }, { otherChain: { chain: '', address: SONIC } }, { otherChain: { chain: 'Sonic', address: 'nope' } }, { otherChain: { chain: 'x'.repeat(41), address: SONIC } }]) {
      expect(otherChainOf(ev)).toBeNull();
    }
  });
  it('one sentence for the report and the feed', () => {
    expect(otherChainCoinText('Sonic')).toBe("Coin on Sonic: not checked (ApeCheck can't read that chain yet)");
  });
});
