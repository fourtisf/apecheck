import { describe, expect, it } from 'vitest';
import { NOT_ENOUGH_LABEL, NOT_ENOUGH_PREFIX, currentStubs, deployerHistoryLine, displayStep, isNotEnough, notEnoughReason, scrubRetired } from '../src/labels';

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

describe('"Not enough to check": a check that could test nothing about the project', () => {
  const STRIDE = 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun.';
  it('isNotEnough tells it from an outage or any other failure by its prefix', () => {
    expect(isNotEnough(STRIDE)).toBe(true);
    expect(STRIDE.startsWith(NOT_ENOUGH_PREFIX)).toBe(true);
    for (const e of ["Nothing about @stridefun could be checked: GitHub didn't answer", 'The check hit an error and could not finish', 'not enough to check: lower case', '', null, undefined]) {
      expect(isNotEnough(e)).toBe(false);
    }
  });
  it('notEnoughReason is the reason as a sentence of its own', () => {
    expect(notEnoughReason(STRIDE)).toBe('No website, GitHub repo or contract on a supported chain was found for @stridefun.');
    expect(NOT_ENOUGH_LABEL).toBe('Not enough to check');
  });
});
