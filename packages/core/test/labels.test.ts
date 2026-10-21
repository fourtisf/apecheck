import { describe, expect, it } from 'vitest';
import { displayStep } from '../src/labels';

describe('displayStep: steps stored before the third-party coin sources were dropped', () => {
  it('reads their "unavailable" lines as "not checked", without the retired source tag', () => {
    expect(displayStep({ text: 'DevRadar unavailable, deployer history unknown (0xAbC…Ef02)', source: 'DevRadar' })).toEqual({
      text: 'Deployer history not checked (0xAbC…Ef02)',
      source: null,
    });
    expect(displayStep({ text: 'BundleScan unavailable, bundle share unknown', source: 'BundleScan' })).toEqual({ text: 'Bundle share not checked', source: null });
    expect(displayStep({ text: 'WhaleFlow unavailable, holder share unknown', source: 'WhaleFlow' })).toEqual({ text: 'Holder share not checked', source: null });
    expect(displayStep({ text: 'Liquidity locked 6 mo; holder share unknown (WhaleFlow unavailable)', source: 'WhaleFlow' }).text).toBe(
      'Liquidity locked 6 mo; holder share not checked',
    );
  });
  it('keeps a result line, only without the tag; leaves every other source alone', () => {
    expect(displayStep({ text: 'Launch: 12.4% of supply bought by 7 bundled wallets', source: 'BundleScan' })).toEqual({
      text: 'Launch: 12.4% of supply bought by 7 bundled wallets',
      source: null,
    });
    const gh = { text: 'GitHub: 2 repos, 7 commits', source: 'GitHub', idx: 3 };
    expect(displayStep(gh)).toBe(gh);
  });
});
