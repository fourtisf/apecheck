/** Minimal EVM ABI helpers for the read-only calls the chain adapters make (no ethers/viem dependency). */

export const SELECTORS = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  owner: '0x8da5cb5b',
  getOwner: '0x893d20e8',
  balanceOf: '0x70a08231',
} as const;

/** mint(address,uint256), mint(uint256), _mint(address,uint256) exposed publicly */
export const MINT_SELECTORS = ['40c10f19', 'a0712d68', '4e6ec247'];
export const OWNER_SELECTORS = ['8da5cb5b', '893d20e8'];

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const BURN_ADDRESSES = new Set([
  ZERO_ADDRESS,
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

const strip0x = (h: string | null | undefined) => (h ?? '').replace(/^0x/i, '');

function toBytes(hex: string | null | undefined): Buffer | null {
  const h = strip0x(hex);
  if (!h || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  return Buffer.from(h, 'hex');
}

function word(bytes: Buffer, offset: number): bigint | null {
  if (offset < 0 || offset + 32 > bytes.length) return null;
  return BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex'));
}

function cleanText(s: string): string | null {
  const t = s.replace(/[\u0000-\u001f\u007f�]/g, '').trim();
  return t ? t.slice(0, 200) : null;
}

/** ABI `string` return value, or a bytes32 string (older tokens such as MKR). */
export function decodeAbiString(hex: string | null | undefined): string | null {
  const bytes = toBytes(hex);
  if (!bytes || bytes.length === 0) return null;
  if (bytes.length >= 64) {
    const offset = word(bytes, 0);
    if (offset != null && offset <= BigInt(bytes.length - 32)) {
      const off = Number(offset);
      const len = word(bytes, off);
      if (len != null && BigInt(off + 32) + len <= BigInt(bytes.length)) {
        return cleanText(bytes.subarray(off + 32, off + 32 + Number(len)).toString('utf8'));
      }
    }
  }
  if (bytes.length === 32) {
    let end = 32;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return cleanText(bytes.subarray(0, end).toString('utf8'));
  }
  return null;
}

export function decodeUint(hex: string | null | undefined): bigint | null {
  const bytes = toBytes(hex);
  if (!bytes || bytes.length < 32) return null;
  return word(bytes, 0);
}

/** First word as a lowercase 0x address, or null when the return data is too short. */
export function decodeAddress(hex: string | null | undefined): string | null {
  const bytes = toBytes(hex);
  if (!bytes || bytes.length < 32) return null;
  return '0x' + bytes.subarray(12, 32).toString('hex');
}

export function encodeAddressArg(address: string): string {
  return strip0x(address).toLowerCase().padStart(64, '0');
}

/** Error(string) / Panic(uint256) revert data → readable reason. */
export function decodeRevert(data: string | null | undefined): string | null {
  const h = strip0x(data).toLowerCase();
  if (!h) return null;
  if (h.startsWith('08c379a0')) return decodeAbiString('0x' + h.slice(8)) ?? 'reverted';
  if (h.startsWith('4e487b71')) {
    const code = decodeUint('0x' + h.slice(8));
    return code != null ? `panic 0x${code.toString(16)}` : 'panic';
  }
  return `reverted with data 0x${h.slice(0, 8)}`;
}

/**
 * Selectors pushed with PUSH4 in the bytecode (what a Solidity dispatcher does). Walks opcodes so bytes
 * inside other PUSH data are not mistaken for selectors.
 */
export function bytecodeSelectors(code: string | null | undefined): Set<string> {
  const out = new Set<string>();
  const bytes = toBytes(code);
  if (!bytes) return out;
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0x63 && i + 4 < bytes.length) out.add(bytes.subarray(i + 1, i + 5).toString('hex'));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return out;
}

export function hasAnySelector(code: string | null | undefined, selectors: string[]): boolean {
  const found = bytecodeSelectors(code);
  return selectors.some(s => found.has(strip0x(s).toLowerCase()));
}

/** EIP-1167 minimal proxy → implementation address */
export function minimalProxyTarget(code: string | null | undefined): string | null {
  const m = /^(?:0x)?363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code ?? '');
  return m ? '0x' + m[1].toLowerCase() : null;
}

/** EIP-1967 implementation slot */
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** hex quantity for JSON-RPC from "0x…" or a decimal string; undefined when empty/invalid */
export function toQuantity(v: string | null | undefined): string | undefined {
  if (v == null || v === '') return undefined;
  try {
    const n = BigInt(v);
    if (n < 0n) return undefined;
    return '0x' + n.toString(16);
  } catch {
    return undefined;
  }
}
