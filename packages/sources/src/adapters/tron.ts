/**
 * Tron via TronGrid (works without a key at a low rate; TRON-PRO-API-KEY when TRONGRID_API_KEY is set).
 * Token basics with constant (read-only) contract calls; creator from /wallet/getcontract.
 */
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import type { Http, TronSource } from '../types';
import { MINT_SELECTORS, decodeAbiString, decodeAddress, decodeUint, hasAnySelector, looksLikeProxy, ownerlessRenounced } from '../abi';
import { tronFromHex } from '../base58';
import { ErrorState, RE_TRON_ADDRESS } from '../util';

const TIMEOUT_MS = 8_000;
export const TRONGRID_BASE = 'https://api.trongrid.io';
/** base58 of 0x41 followed by 20 zero bytes */
export const TRON_ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

const ContractZ = z.object({
  contract_address: z.string().optional(),
  origin_address: z.string().optional(),
  bytecode: z.string().optional(),
  name: z.string().optional(),
});
const ConstantZ = z.object({
  result: z.object({ result: z.boolean().optional(), code: z.string().optional(), message: z.string().optional() }).partial().optional(),
  constant_result: z.array(z.string()).optional(),
  transaction: z.object({ ret: z.array(z.object({ ret: z.string().optional() }).partial()).optional() }).partial().optional(),
});
/**
 * TronGrid result codes for a call it did not run (a busy or unsynced node, an internal exception): a failed read,
 * never "the function isn't there". CONTRACT_EXE_ERROR / CONTRACT_VALIDATE_ERROR are the contract's answer (a revert).
 */
const TRON_NOT_RUN = new Set(['SERVER_BUSY', 'NO_CONNECTION', 'NOT_ENOUGH_EFFECTIVE_CONNECTION', 'BLOCK_UNSOLIDIFIED', 'OTHER_ERROR']);

type TronTokenInfo = NonNullable<Awaited<ReturnType<TronSource['tokenInfo']>>>;

export class TronAdapter implements TronSource {
  readonly configured = true;
  private readonly errors = new ErrorState('tron');
  private readonly headers: Record<string, string>;

  constructor(env: Pick<Env, 'TRONGRID_API_KEY'>, private readonly http: Http) {
    this.headers = { 'content-type': 'application/json' };
    if (env.TRONGRID_API_KEY) this.headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;
  }

  get lastError() {
    return this.errors.lastError;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.http.json(`${TRONGRID_BASE}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
      maxBytes: 4 * 1024 * 1024,
    });
  }

  /**
   * constant call → return data hex, or null when the contract reverted / returned nothing. A call TronGrid did not
   * run throws (an HTTP error such as a 429, a busy node, an answer without a result): that is not a revert.
   */
  private async constant(address: string, signature: string): Promise<string | null> {
    const res = ConstantZ.parse(
      await this.post('/wallet/triggerconstantcontract', {
        owner_address: address,
        contract_address: address,
        function_selector: signature,
        parameter: '',
        visible: true,
      }),
    );
    if (res.result?.result !== true) {
      const code = res.result?.code;
      if (!code || TRON_NOT_RUN.has(code)) throw new Error(`TronGrid did not run ${signature} (${code ?? 'no result'})`);
      return null;
    }
    // the call ran but reverted: its return data is the revert reason, not a value
    if (res.transaction?.ret?.[0]?.ret === 'FAILED') return null;
    const hex = res.constant_result?.[0];
    return hex ? '0x' + hex : null;
  }

  async tokenInfo(address: string): Promise<TronTokenInfo | null> {
    if (!RE_TRON_ADDRESS.test(address)) return null;
    try {
      const contract = ContractZ.parse(await this.post('/wallet/getcontract', { value: address, visible: true }));
      if (!contract.contract_address) return null;
      // a call TronGrid didn't run (a 429, a busy node) leaves that value unknown and is reported, like owner()
      const safe = (sig: string) =>
        this.constant(address, sig).catch((e: unknown) => {
          this.errors.fail(`tokenInfo ${sig.replace(/\(\)$/, '')}`, e);
          return null;
        });
      // owner() decides "renounced" (and the re-check alerts' contract fingerprint): a call TronGrid didn't run is
      // reported and leaves who controls the token unknown, never "no owner function"
      const ownerRead = this.constant(address, 'owner()').then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const [name, symbol, decimals, totalSupply, ownerRes] = await Promise.all([
        safe('name()'), safe('symbol()'), safe('decimals()'), safe('totalSupply()'), ownerRead,
      ]);
      if (!ownerRes.ok) this.errors.fail('tokenInfo owner', ownerRes.error);
      const owner = ownerRes.ok ? ownerRes.value : null;
      const code = contract.bytecode ? '0x' + contract.bytecode : null;
      // a proxy's own code has no mint selector to find (its logic is elsewhere, unread here): unknown, not "none"
      const hasMintFunction = !code ? null : hasAnySelector(code, MINT_SELECTORS) ? true : looksLikeProxy(code) ? null : false;
      const ownerHex = decodeAddress(owner);
      const ownerAddr = ownerHex ? tronFromHex(ownerHex) : null;
      let ownerRenounced: boolean | null = null;
      if (ownerAddr) ownerRenounced = ownerAddr === TRON_ZERO_ADDRESS;
      // no owner(): renounced only when nothing else (roles, a mint function) can control the supply
      else if (ownerRes.ok) ownerRenounced = ownerlessRenounced(code, hasMintFunction);
      const dec = decodeUint(decimals);
      const supply = decodeUint(totalSupply);
      return {
        name: decodeAbiString(name) ?? contract.name ?? null,
        symbol: decodeAbiString(symbol),
        decimals: dec != null && dec < 256n ? Number(dec) : null,
        totalSupply: supply != null ? supply.toString() : null,
        owner: ownerAddr,
        creator: contract.origin_address ?? null,
        hasMintFunction,
        ownerRenounced,
      };
    } catch (e) {
      this.errors.fail('tokenInfo', e);
      return null;
    }
  }
}

export function createTron(env: Pick<Env, 'TRONGRID_API_KEY'>, http: Http): TronAdapter {
  return new TronAdapter(env, http);
}
