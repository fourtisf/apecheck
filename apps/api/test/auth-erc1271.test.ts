/**
 * Smart-wallet sign-in through the real EVM adapter (packages/sources createEvm) over a fake RPC: EIP-1271 counts only
 * the whole ABI-encoded magic word, so a contract that echoes its call data (which starts with the same selector),
 * such as the identity precompile 0x…04, can't be signed in as with a junk signature.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MeDTO } from '@apecheck/core';
import { ERC1271_MAGIC_WORD, createEvm, type Http, type HttpRequest, type HttpResponse } from '@apecheck/sources';
import { Client, FakeSources, makeHarness, resetState, signIn, testEnv, type Harness, type Wallet } from './helpers';

const IDENTITY_PRECOMPILE = '0x0000000000000000000000000000000000000004';
const ECHO_CONTRACT = '0x00000000000000000000000000000000000e0c40';
const SMART_WALLET = '0x5555555555555555555555555555555555555555';
const JUNK = '0x' + '11'.repeat(65);

/** Base RPC: eth_call to an echoing address returns its call data, the smart wallet returns the magic word, others "0x". */
class EvmRpcSources extends FakeSources {
  ethCalls: { to: string; data: string }[] = [];
  private readonly rpc: Http = {
    request: async (url: string, req: HttpRequest = {}): Promise<HttpResponse> => {
      const body = JSON.parse(String(req.body)) as { id: number; method: string; params: [{ to: string; data: string }, string] };
      let result: unknown = null;
      if (new URL(url).host === 'mainnet.base.org' && body.method === 'eth_call') {
        const { to, data } = body.params[0];
        this.ethCalls.push({ to, data });
        const t = to.toLowerCase();
        result = t === IDENTITY_PRECOMPILE || t === ECHO_CONTRACT ? data : t === SMART_WALLET ? ERC1271_MAGIC_WORD : '0x';
      }
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return { status: 200, ok: true, url, finalUrl: url, headers: {}, text, truncated: false, ms: 1 };
    },
    json: async <T>(url: string, req?: HttpRequest): Promise<T> => JSON.parse((await this.rpc.request(url, req)).text) as T,
  };
  override readonly evm = createEvm(testEnv(), this.rpc);
}

/** a "wallet" that signs nothing: the same 65 junk bytes for any message */
const junkSigner = (address: string) => ({ chain: 'evm', address, sign: () => JUNK }) as unknown as Wallet;

describe('EIP-1271 sign-in over the real EVM adapter', () => {
  let h: Harness;
  let sources: EvmRpcSources;
  beforeAll(async () => {
    sources = new EvmRpcSources();
    h = await makeHarness({}, { sources });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    sources.ethCalls = [];
  });

  it('the identity precompile (echoes its call data) is refused: 401 bad_signature, no session, no user', async () => {
    const c = new Client(h.app, '198.51.100.8');
    const res = await signIn(c, junkSigner(IDENTITY_PRECOMPILE));
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('bad_signature');
    expect((await c.get('/v1/me')).json<MeDTO>().user).toBeNull();
    expect(await h.prisma.user.count()).toBe(0);
  });

  it('any contract echoing its call data is refused, although the echo starts with the magic selector', async () => {
    const res = await signIn(new Client(h.app, '198.51.100.9'), junkSigner(ECHO_CONTRACT));
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('bad_signature');
    // it was asked: the echo is refused by the adapter's check, not skipped
    expect(sources.ethCalls.map(c => c.to.toLowerCase())).toEqual([ECHO_CONTRACT]);
    expect(sources.ethCalls[0].data.slice(0, 10)).toBe(ERC1271_MAGIC_WORD.slice(0, 10));
    expect(await h.prisma.user.count()).toBe(0);
  });

  it('a smart wallet answering the padded magic word signs in', async () => {
    const res = await signIn(new Client(h.app, '198.51.100.10'), junkSigner(SMART_WALLET));
    expect(res.statusCode).toBe(200);
    expect(res.json<MeDTO>().user?.evmAddress?.toLowerCase()).toBe(SMART_WALLET);
  });
});
