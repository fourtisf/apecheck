/**
 * Tron via TronGrid (works without a key at a low rate; TRON-PRO-API-KEY when TRONGRID_API_KEY is set).
 * Token basics with constant (read-only) contract calls; creator from /wallet/getcontract.
 */
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import type { Http, TronSource } from '../types';
import { MINT_SELECTORS, OWNER_SELECTORS, decodeAbiString, decodeAddress, decodeUint, hasAnySelector } from '../abi';
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
});

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

  /** constant call → return data hex, or null when it reverted / returned nothing */
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
    if (res.result?.result !== true) return null;
    const hex = res.constant_result?.[0];
    return hex ? '0x' + hex : null;
  }

  async tokenInfo(address: string): Promise<TronTokenInfo | null> {
    if (!RE_TRON_ADDRESS.test(address)) return null;
    try {
      const contract = ContractZ.parse(await this.post('/wallet/getcontract', { value: address, visible: true }));
      if (!contract.contract_address) return null;
      const safe = (sig: string) => this.constant(address, sig).catch(() => null);
      const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
        safe('name()'), safe('symbol()'), safe('decimals()'), safe('totalSupply()'), safe('owner()'),
      ]);
      const code = contract.bytecode ? '0x' + contract.bytecode : null;
      const hasMintFunction = code ? hasAnySelector(code, MINT_SELECTORS) : null;
      const ownerHex = decodeAddress(owner);
      const ownerAddr = ownerHex ? tronFromHex(ownerHex) : null;
      let ownerRenounced: boolean | null = null;
      if (ownerAddr) ownerRenounced = ownerAddr === TRON_ZERO_ADDRESS;
      else if (code && !hasAnySelector(code, OWNER_SELECTORS)) ownerRenounced = true;
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
