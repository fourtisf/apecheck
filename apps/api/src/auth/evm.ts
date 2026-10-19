/**
 * EVM wallet signatures for Sign-In with Ethereum (M3).
 *
 * personal_sign: hash = keccak256("\x19Ethereum Signed Message:\n" + byteLength(message) + message). The 65-byte
 * signature r ‖ s ‖ v (v = 27/28, or 0/1) is recovered with secp256k1 (high-s refused, as Ethereum does since
 * Homestead), the address is the last 20 bytes of keccak256(uncompressed public key without its 0x04 prefix).
 *
 * Smart-contract wallets (Safe, Coinbase Smart Wallet, Argent…) don't have a key: when recovery doesn't give the
 * address, EIP-1271 `isValidSignature(hash, signature)` is asked on exactly ONE chain, with a short timeout: the chain
 * the server picks (contractWalletChain), which the signed message's EIP-4361 `Chain ID` must name. A contract address
 * is controlled separately on every chain (a Safe's owners rotate per chain, a factory can be replayed elsewhere, or
 * nothing is deployed there yet and anyone may deploy to it), so trying several chains, or the one the client picks,
 * would let whoever controls the address on the weakest chain sign in as the wallet that holds on TOKEN_CHAIN.
 * Counterfactual (not yet deployed) wallets wrapped in ERC-6492 are not supported.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { CHAINS, type ChainKey, type Env } from '@apecheck/core';
import { tokenChain } from '@apecheck/db';
import type { ApiSources } from '../context';

export const ERC1271_TIMEOUT_MS = 4_000;
/** where smart wallets are checked while TOKEN_CHAIN isn't an EVM chain (their wallets then never count for tiers) */
export const DEFAULT_CONTRACT_WALLET_CHAIN: ChainKey = 'base';

export interface ContractWalletChain {
  chain: ChainKey;
  /** its EIP-155 chain id: the `Chain ID` a smart wallet's sign-in message must carry */
  chainId: number;
}

/**
 * The one chain an EVM smart wallet (EIP-1271) is resolved on, chosen by the server and never by the client:
 * TOKEN_CHAIN when it is an EVM chain (the chain whose $APECHECK balance makes the tier, so only whoever controls the
 * contract there can sign in as it), else Base. Null when TOKEN_CHAIN is an EVM chain without a known chain id: smart
 * wallets can't sign in then (key wallets always can).
 */
export function contractWalletChain(env: Pick<Env, 'TOKEN_CHAIN'>): ContractWalletChain | null {
  const token = tokenChain(env);
  const chain = token && CHAINS[token].family === 'evm' ? token : DEFAULT_CONTRACT_WALLET_CHAIN;
  const chainId = CHAINS[chain].chainId;
  return chainId ? { chain, chainId } : null;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function personalSignHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

export function addressOfPublicKey(uncompressed: Uint8Array): string {
  return '0x' + hex(keccak_256(uncompressed.subarray(1))).slice(-40);
}

/** 0x-prefixed hex → bytes, or null when it isn't hex. */
export function hexBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(s)) return null;
  return Uint8Array.from(Buffer.from(s.slice(2), 'hex'));
}

/**
 * The lowercase address that produced a 65-byte personal_sign signature of `message`, or null for a signature that
 * isn't one (wrong length, v not 27/28/0/1, r or s out of range, high s, no valid point).
 */
export function recoverPersonalSign(message: string, signature: string): string | null {
  const sig = hexBytes(signature);
  if (!sig || sig.length !== 65) return null;
  let v = sig[64];
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const s = secp256k1.Signature.fromCompact(sig.subarray(0, 64));
    if (s.hasHighS()) return null;
    const point = s.addRecoveryBit(v).recoverPublicKey(personalSignHash(message));
    return addressOfPublicKey(point.toRawBytes(false));
  } catch {
    return null;
  }
}

export type EvmVerifyResult =
  | { ok: true; via: 'ecrecover' }
  | { ok: true; via: 'erc1271'; chain: ChainKey }
  /**
   * bad_signature: not this wallet's signature. wrong_chain: not a key signature, and the message's Chain ID isn't the
   * smart-wallet chain (nothing was asked). unavailable: that chain's RPC didn't answer (try again).
   */
  | { ok: false; reason: 'bad_signature' | 'wrong_chain' | 'unavailable'; chain?: ChainKey };

export interface EvmVerifyOptions {
  /** the `Chain ID` of the signed EIP-4361 message */
  signedChainId: number | null;
  /** contractWalletChain(env): the only chain EIP-1271 is asked on (null: smart wallets can't sign in) */
  contract: ContractWalletChain | null;
}

/**
 * Did `address` sign `message`? A key wallet by recovery (on any chain id: a key signs the same everywhere), else a
 * smart wallet by EIP-1271 on `contract.chain` alone, and only when the message names that chain.
 */
export async function verifyEvmSignature(
  sources: Pick<ApiSources, 'evm'>,
  address: string,
  message: string,
  signature: string,
  opts: EvmVerifyOptions,
): Promise<EvmVerifyResult> {
  if (!hexBytes(signature) || signature.length > 2 + 2 * 4096) return { ok: false, reason: 'bad_signature' };
  const recovered = recoverPersonalSign(message, signature);
  if (recovered && recovered === address.toLowerCase()) return { ok: true, via: 'ecrecover' };
  const target = opts.contract;
  if (!target) return { ok: false, reason: 'bad_signature' };
  // EIP-4361: contract accounts are resolved on the message's Chain ID; it must be the chain the server checks
  if (opts.signedChainId !== target.chainId) return { ok: false, reason: 'wrong_chain', chain: target.chain };
  const hash = '0x' + hex(personalSignHash(message));
  const valid = await sources.evm.isValidSignature(target.chain, address, hash, signature, { timeoutMs: ERC1271_TIMEOUT_MS }).catch(() => null);
  if (valid === true) return { ok: true, via: 'erc1271', chain: target.chain };
  // no other chain is tried, also when this one is down: the client signs in again later
  if (valid == null) return { ok: false, reason: 'unavailable', chain: target.chain };
  return { ok: false, reason: 'bad_signature' };
}
