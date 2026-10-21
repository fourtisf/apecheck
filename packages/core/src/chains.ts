/** Chains ApeCheck understands. Keys are the lowercase API values; `db` is the Prisma enum value. */
export type ChainKey = 'sol' | 'eth' | 'base' | 'bnb' | 'arb' | 'rh' | 'trx';
export type ChainDb = 'SOL' | 'ETH' | 'BASE' | 'BNB' | 'ARB' | 'RH' | 'TRX';

export interface ChainInfo {
  key: ChainKey;
  db: ChainDb;
  /** Display name, e.g. "Robinhood Chain" */
  name: string;
  /** Short tag, e.g. "RH" */
  s: string;
  /** Tag dot colour (same as the prototype) */
  c: string;
  family: 'evm' | 'sol' | 'trx';
  /** EVM chain id (EIP-155: the mock wallet, wallet sign-in, the doctor; Etherscan V2 on the chains it indexes) */
  chainId?: number;
  /** DexScreener chain id */
  dex: string;
  /** Env var holding this chain's RPC URL */
  rpcEnv: string;
  explorer?: string;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  sol:  { key: 'sol',  db: 'SOL',  name: 'Solana',          s: 'SOL',  c: '#A796FF', family: 'sol', dex: 'solana',   rpcEnv: 'RPC_SOLANA', explorer: 'https://solscan.io/token/' },
  base: { key: 'base', db: 'BASE', name: 'Base',            s: 'BASE', c: '#5B8CFF', family: 'evm', chainId: 8453,  dex: 'base',     rpcEnv: 'RPC_BASE', explorer: 'https://basescan.org/token/' },
  eth:  { key: 'eth',  db: 'ETH',  name: 'Ethereum',        s: 'ETH',  c: '#8A94B8', family: 'evm', chainId: 1,     dex: 'ethereum', rpcEnv: 'RPC_ETH', explorer: 'https://etherscan.io/token/' },
  bnb:  { key: 'bnb',  db: 'BNB',  name: 'BNB Chain',       s: 'BNB',  c: '#F0C24B', family: 'evm', chainId: 56,    dex: 'bsc',      rpcEnv: 'RPC_BSC', explorer: 'https://bscscan.com/token/' },
  rh:   { key: 'rh',   db: 'RH',   name: 'Robinhood Chain', s: 'RH',   c: '#3EDDB0', family: 'evm', chainId: 4663,  dex: 'robinhood', rpcEnv: 'RPC_ROBINHOOD', explorer: 'https://robinhoodchain.blockscout.com/token/' },
  trx:  { key: 'trx',  db: 'TRX',  name: 'Tron',            s: 'TRX',  c: '#FF6F7D', family: 'trx', dex: 'tron',     rpcEnv: 'TRONGRID_API_KEY', explorer: 'https://tronscan.org/#/token20/' },
  arb:  { key: 'arb',  db: 'ARB',  name: 'Arbitrum',        s: 'ARB',  c: '#5CC8F0', family: 'evm', chainId: 42161, dex: 'arbitrum', rpcEnv: 'RPC_ARB', explorer: 'https://arbiscan.io/token/' },
};

/** Display order used by filters (same order as the prototype's CHAINS object). */
export const CHAIN_ORDER: ChainKey[] = ['sol', 'base', 'eth', 'bnb', 'rh', 'trx', 'arb'];

/** HANDOFF §4 Stage A: EVM contracts are tried on these chains, in this order, until code exists. */
export const EVM_DETECT_ORDER: ChainKey[] = ['base', 'eth', 'bnb', 'arb', 'rh'];

export const chainFromDb = (c: ChainDb | null | undefined): ChainKey | null =>
  c ? (c.toLowerCase() as ChainKey) : null;
export const chainToDb = (c: ChainKey | null | undefined): ChainDb | null =>
  c ? CHAINS[c].db : null;
export const isChainKey = (v: unknown): v is ChainKey => typeof v === 'string' && v in CHAINS;

/**
 * A deployer wallet as ApeCheck stores and compares it (CoinFacts.deployerAddress): EVM lowercased, Solana and Tron
 * (case-sensitive base58) as they are.
 */
export const deployerKey = (chain: ChainKey, address: string): string => (CHAINS[chain]?.family === 'evm' ? address.toLowerCase() : address);

/** DexScreener chainId → ChainKey */
export function chainFromDex(dexChainId: string): ChainKey | null {
  const hit = (Object.values(CHAINS) as ChainInfo[]).find(c => c.dex === dexChainId);
  return hit ? hit.key : null;
}
