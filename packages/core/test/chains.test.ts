import { describe, expect, it } from 'vitest';
import { CHAINS, EVM_DETECT_ORDER, chainFromDex, type ChainKey } from '../src/chains';

describe('chains', () => {
  it('Robinhood Chain mainnet: chain id 4663, its Blockscout explorer, DexScreener id "robinhood"', () => {
    expect(CHAINS.rh).toMatchObject({ family: 'evm', chainId: 4663, explorer: 'https://robinhoodchain.blockscout.com/token/', rpcEnv: 'RPC_ROBINHOOD' });
    expect(chainFromDex('robinhood')).toBe('rh');
  });

  it('every EVM chain has a distinct chain id and an explorer', () => {
    const evm = (Object.keys(CHAINS) as ChainKey[]).filter(c => CHAINS[c].family === 'evm');
    expect([...evm].sort()).toEqual([...EVM_DETECT_ORDER].sort());
    for (const c of evm) {
      expect(CHAINS[c].chainId, c).toBeGreaterThan(0);
      expect(CHAINS[c].explorer, c).toMatch(/^https:\/\//);
    }
    expect(new Set(evm.map(c => CHAINS[c].chainId)).size).toBe(evm.length);
  });
});
