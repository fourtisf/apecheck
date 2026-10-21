import { describe, expect, it } from 'vitest';
import { createEvm, EVM_READ_METHODS, PUBLIC_EVM_RPC, resolveEvmRpc } from '../src/adapters/evm';
import {
  bytecodeSelectors, decodeAbiString, decodeRevert, EIP1822_PROXIABLE_SLOT, EIP1967_BEACON_SLOT, EIP1967_IMPL_SLOT, MINT_SELECTORS,
  ownerlessRenounced, looksLikeProxy, ZEPPELINOS_IMPL_SLOT,
} from '../src/abi';
import { jsonRpc } from '../src/rpc';
import { captureErrors } from '../src/util';
import { encAddress, encBytes32, encString, encUint, fakeHttp, rpcHandler, testEnv, word, type Handler } from './helpers';
import { keccak256, selector } from './keccak';

const TOKEN = '0x4200000000000000000000000000000000000abc';
const IMPL = '0x1111111111111111111111111111111111111111';
const OWNER = '0x9999999999999999999999999999999999999999';

/** dispatcher-like bytecode: PUSH4 <selector> EQ … for each selector, plus a PUSH32 whose data hides the mint selector */
function bytecode(selectors: string[], { hideMintInPushData = false } = {}): string {
  let code = '6080604052';
  for (const s of selectors) code += '63' + s + '14610100' + '57';
  if (hideMintInPushData) code += '7f' + ('6340c10f19' + '00'.repeat(27)) + '50';
  return '0x' + code + '00';
}
const ERC20 = ['06fdde03', '95d89b41', '313ce567', '18160ddd', '70a08231', 'a9059cbb'];
/**
 * A transparent proxy's own code, like Circle's FiatTokenProxy (USDC): admin(), implementation(), upgradeTo(),
 * changeAdmin(), upgradeToAndCall() and a fallback that DELEGATECALLs (GAS DELEGATECALL …); no ERC-20 selector.
 */
const PROXY_CODE = bytecode(['f851a440', '5c60da1b', '3659cfe6', '8f283970', '4f1ef286']) + '5af43d6000803e3d6000f3';

type Calls = Record<string, (params: unknown[]) => unknown>;
function evmNode(
  host: string,
  opts: { code?: string; calls?: Record<string, unknown>; storage?: string; slots?: Record<string, string>; implCode?: string; extra?: Calls },
) {
  return rpcHandler(host, {
    eth_getCode: p => ((p[0] as string).toLowerCase() === IMPL ? opts.implCode ?? '0x' : opts.code ?? '0x'),
    eth_getStorageAt: p => opts.slots?.[p[1] as string] ?? opts.storage ?? '0x' + '0'.repeat(64),
    eth_call: p => {
      const { data } = p[0] as { data: string };
      const v = opts.calls?.[data];
      if (v === undefined) return { error: { code: 3, message: 'execution reverted' } };
      return v;
    },
    ...opts.extra,
  });
}

describe('EVM adapter: RPC selection', () => {
  it('public fallbacks for Base/Ethereum/BNB/Arbitrum, Robinhood Chain only from env', () => {
    expect(createEvm(testEnv(), fakeHttp()).chains()).toEqual(['base', 'eth', 'bnb', 'arb']);
    expect(createEvm(testEnv({ RPC_ROBINHOOD: 'https://rpc.rh.example' }), fakeHttp()).chains()).toEqual(['base', 'eth', 'bnb', 'rh', 'arb']);
    expect(PUBLIC_EVM_RPC).toEqual({
      base: 'https://mainnet.base.org',
      eth: 'https://ethereum-rpc.publicnode.com',
      bnb: 'https://bsc-dataseed.binance.org',
      arb: 'https://arb1.arbitrum.io/rpc',
    });
  });

  it('env RPC URLs win over the public fallbacks', async () => {
    const http = fakeHttp(rpcHandler('base.rpc.example', { eth_getCode: () => '0x60' }), rpcHandler('mainnet.base.org', { eth_getCode: () => '0x' }));
    const evm = createEvm(testEnv({ RPC_BASE: 'https://base.rpc.example/key' }), http);
    expect(await evm.getCode('base', TOKEN)).toBe('0x60');
    expect(http.calls[0].url).toBe('https://base.rpc.example/key');
    expect(http.calls[0].body).toMatchObject({ jsonrpc: '2.0', method: 'eth_getCode', params: [TOKEN, 'latest'] });
  });

  it('one ALCHEMY_API_KEY keys Ethereum, Base and Arbitrum; RPC_* still wins; BNB and Robinhood Chain are not covered', () => {
    const env = testEnv({ ALCHEMY_API_KEY: 'alc_KEY', RPC_ARB: 'https://arb.own.example/k' });
    expect(resolveEvmRpc(env, 'eth')).toEqual({ url: 'https://eth-mainnet.g.alchemy.com/v2/alc_KEY', source: 'alchemy' });
    expect(resolveEvmRpc(env, 'base')).toEqual({ url: 'https://base-mainnet.g.alchemy.com/v2/alc_KEY', source: 'alchemy' });
    expect(resolveEvmRpc(env, 'arb')).toEqual({ url: 'https://arb.own.example/k', source: 'env' });
    expect(resolveEvmRpc(env, 'bnb')).toEqual({ url: PUBLIC_EVM_RPC.bnb, source: 'public' });
    expect(resolveEvmRpc(env, 'rh')).toBeNull();
    expect(resolveEvmRpc(testEnv(), 'eth')).toEqual({ url: PUBLIC_EVM_RPC.eth, source: 'public' });
  });

  it('the adapter reads through Alchemy when ALCHEMY_API_KEY is set', async () => {
    const http = fakeHttp(rpcHandler('eth-mainnet.g.alchemy.com', { eth_getCode: () => '0x60' }));
    expect(await createEvm(testEnv({ ALCHEMY_API_KEY: 'alc_KEY' }), http).getCode('eth', TOKEN)).toBe('0x60');
    expect(http.calls[0].url).toBe('https://eth-mainnet.g.alchemy.com/v2/alc_KEY');
  });

  it('stubs(): etherscan without a key, rpc-rh without RPC_ROBINHOOD', () => {
    expect(createEvm(testEnv(), fakeHttp()).stubs()).toEqual(['etherscan', 'rpc-rh']);
    expect(createEvm(testEnv({ ETHERSCAN_API_KEY: 'k', RPC_ROBINHOOD: 'https://rh' }), fakeHttp()).stubs()).toEqual([]);
  });
});

describe('EVM adapter: detectChain', () => {
  it('tries Base, Ethereum, BNB, Arbitrum, Robinhood in order and returns the first with code', async () => {
    const http = fakeHttp(
      rpcHandler('mainnet.base.org', { eth_getCode: () => '0x' }),
      rpcHandler('ethereum-rpc.publicnode.com', { eth_getCode: () => '0x6080' }),
      rpcHandler('bsc-dataseed.binance.org', { eth_getCode: () => '0x6080' }),
      rpcHandler('arb1.arbitrum.io', { eth_getCode: () => '0x' }),
    );
    expect(await createEvm(testEnv(), http).detectChain(TOKEN)).toBe('eth');
  });

  it('a failing chain does not stop detection; nothing found → null', async () => {
    const http = fakeHttp(
      url => (url.host === 'mainnet.base.org' ? { status: 503, text: 'down' } : undefined),
      rpcHandler('ethereum-rpc.publicnode.com', { eth_getCode: () => '0x' }),
      rpcHandler('bsc-dataseed.binance.org', { eth_getCode: () => '0x' }),
      rpcHandler('arb1.arbitrum.io', { eth_getCode: () => '0x60806040' }),
      rpcHandler('rpc.rh.example', { eth_getCode: () => '0x' }),
    );
    const evm = createEvm(testEnv({ RPC_ROBINHOOD: 'https://rpc.rh.example' }), http);
    expect(await evm.detectChain(TOKEN)).toBe('arb');
    expect(evm.lastError).toMatch(/^evm\.getCode base: HTTP 503/);
    const none = fakeHttp(url => (url.host ? { json: { jsonrpc: '2.0', id: 1, result: '0x' } } : undefined));
    expect(await createEvm(testEnv(), none).detectChain(TOKEN)).toBeNull();
  });

  it('rejects malformed addresses without any request', async () => {
    const http = fakeHttp();
    expect(await createEvm(testEnv(), http).detectChain('0x123')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  /** Base answers 429 for its first `failures` eth_getCode calls, then `baseCode`; Ethereum has code. */
  function flakyBase(failures: number, baseCode: string) {
    let baseCalls = 0;
    const http = fakeHttp(
      url => {
        if (url.host !== 'mainnet.base.org') return undefined;
        baseCalls++;
        return baseCalls <= failures ? { status: 429, text: 'rate limited' } : { json: { jsonrpc: '2.0', id: 1, result: baseCode } };
      },
      rpcHandler('ethereum-rpc.publicnode.com', { eth_getCode: () => '0x6080604052' }),
      rpcHandler('bsc-dataseed.binance.org', { eth_getCode: () => '0x' }),
      rpcHandler('arb1.arbitrum.io', { eth_getCode: () => '0x' }),
    );
    const hosts = () => http.calls.map(c => new URL(c.url).host);
    return { http, hosts, evm: createEvm(testEnv(), http, { detectRetryDelayMs: 0 }) };
  }

  it('a later chain is not accepted while an earlier chain is unanswered: the failed chain is asked once more', async () => {
    const { evm, hosts } = flakyBase(1, '0x6080604052');
    const r = await captureErrors(() => evm.detectChain(TOKEN));
    expect(r.value).toBe('base');
    // Base answered on the retry: nothing is reported as unavailable
    expect(r.errors).toEqual([]);
    expect(hosts().filter(h => h === 'mainnet.base.org')).toHaveLength(2);
  });

  it('retry answers "no code": the later chain wins and nothing is reported', async () => {
    const { evm } = flakyBase(1, '0x');
    const r = await captureErrors(() => evm.detectChain(TOKEN));
    expect(r).toEqual({ value: 'eth', errors: [] });
  });

  it('an earlier chain that never answers is reported even though a later chain has code', async () => {
    const { evm, hosts } = flakyBase(99, '0x');
    const r = await captureErrors(() => evm.detectChain(TOKEN));
    expect(r.value).toBe('eth');
    expect(r.errors).toEqual(['evm.getCode base: HTTP 429 from mainnet.base.org']);
    expect(evm.lastError).toBe('evm.getCode base: HTTP 429 from mainnet.base.org');
    // only the failed chain is retried
    expect(hosts().filter(h => h === 'mainnet.base.org')).toHaveLength(2);
    expect(hosts().filter(h => h === 'ethereum-rpc.publicnode.com')).toHaveLength(1);
  });

  it('a chain that fails after the hit is neither retried nor reported', async () => {
    const http = fakeHttp(
      rpcHandler('mainnet.base.org', { eth_getCode: () => '0x6080' }),
      url => (url.host === 'ethereum-rpc.publicnode.com' ? { status: 503, text: 'down' } : undefined),
      rpcHandler('bsc-dataseed.binance.org', { eth_getCode: () => '0x' }),
      rpcHandler('arb1.arbitrum.io', { eth_getCode: () => '0x' }),
    );
    const r = await captureErrors(() => createEvm(testEnv(), http, { detectRetryDelayMs: 0 }).detectChain(TOKEN));
    expect(r).toEqual({ value: 'base', errors: [] });
    expect(http.calls.filter(c => new URL(c.url).host === 'ethereum-rpc.publicnode.com')).toHaveLength(1);
  });
});

describe('EVM adapter: tokenBasics', () => {
  it('decodes ABI string name, bytes32 symbol, decimals, supply; renounced owner (0x…dEaD); mint selector present', async () => {
    const http = fakeHttp(
      evmNode('mainnet.base.org', {
        code: bytecode([...ERC20, '40c10f19', '8da5cb5b']),
        calls: {
          '0x06fdde03': encString('Thing Token'),
          '0x95d89b41': encBytes32('THING'),
          '0x313ce567': encUint(18),
          '0x18160ddd': encUint(10n ** 27n),
          '0x8da5cb5b': encAddress('0x000000000000000000000000000000000000dEaD'),
        },
      }),
    );
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toEqual({
      name: 'Thing Token',
      symbol: 'THING',
      decimals: 18,
      totalSupply: '1000000000000000000000000000',
      owner: '0x000000000000000000000000000000000000dead',
      ownerRenounced: true,
      hasMintFunction: true,
      implementation: null,
    });
  });

  it('active owner, no mint selector (selector bytes inside PUSH32 data are ignored)', async () => {
    const http = fakeHttp(
      evmNode('mainnet.base.org', {
        code: bytecode([...ERC20, '8da5cb5b'], { hideMintInPushData: true }),
        calls: { '0x06fdde03': encString('X'), '0x8da5cb5b': encAddress(OWNER) },
      }),
    );
    const b = await createEvm(testEnv(), http).tokenBasics('base', TOKEN);
    expect(b).toMatchObject({ owner: OWNER, ownerRenounced: false, hasMintFunction: false, symbol: null, decimals: null });
  });

  it('no owner()/getOwner() at all counts as renounced', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode(ERC20), calls: { '0x313ce567': encUint(9) } }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ owner: null, ownerRenounced: true, hasMintFunction: false, decimals: 9 });
  });

  it('AccessControl (MINTER_ROLE) mint without owner(): owner unknown, never renounced', async () => {
    // mint(address,uint256), hasRole, grantRole, getRoleAdmin, MINTER_ROLE(); owner() and getOwner() revert
    const code = bytecode([...ERC20, '40c10f19', '91d14854', '2f2ff15d', '248a9ca3', 'd5391393']);
    const http = fakeHttp(evmNode('mainnet.base.org', { code }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ owner: null, ownerRenounced: null, hasMintFunction: true });
  });

  it('a mint function with no owner() and no known role scheme (custom minter, bridge, public mint) is not "renounced"', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode([...ERC20, 'a0712d68']) }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ owner: null, ownerRenounced: null, hasMintFunction: true });
  });

  it('role-based control without a mint function: owner unknown (not "renounced")', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode([...ERC20, '91d14854', '2f2ff15d']) }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ ownerRenounced: null, hasMintFunction: false });
  });

  it('role-based control in the implementation behind an EIP-1967 proxy is seen too', async () => {
    const http = fakeHttp(
      evmNode('mainnet.base.org', { code: '0x363d3d37' + 'aa'.repeat(40), storage: encAddress(IMPL), implCode: bytecode([...ERC20, '40c10f19', '91d14854']) }),
    );
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ ownerRenounced: null, hasMintFunction: true });
  });

  it('no owner() but the bytecode could not be read: unknown, not "renounced"', async () => {
    const http = fakeHttp(
      rpcHandler('mainnet.base.org', {
        eth_getCode: () => ({ error: { code: -32000, message: 'header not found' } }),
        eth_call: () => ({ error: { code: 3, message: 'execution reverted' } }),
      }),
    );
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ owner: null, ownerRenounced: null, hasMintFunction: null });
  });

  it('getOwner() (BEP-20) is used when owner() reverts', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode([...ERC20, '893d20e8']), calls: { '0x893d20e8': encAddress(OWNER) } }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ owner: OWNER, ownerRenounced: false });
  });

  it('scans the implementation behind an EIP-1967 proxy', async () => {
    const http = fakeHttp(
      evmNode('mainnet.base.org', {
        code: '0x363d3d37' + 'aa'.repeat(40),
        storage: encAddress(IMPL),
        implCode: bytecode([...ERC20, 'a0712d68', '8da5cb5b']),
        calls: { '0x8da5cb5b': encAddress(OWNER) },
      }),
    );
    const b = await createEvm(testEnv(), http).tokenBasics('base', TOKEN);
    expect(b).toMatchObject({ hasMintFunction: true, ownerRenounced: false });
    const storageCall = http.calls.find(c => (c.body as { method: string }).method === 'eth_getStorageAt');
    expect((storageCall?.body as { params: unknown[] }).params).toEqual([TOKEN, EIP1967_IMPL_SLOT, 'latest']);
  });

  it('EIP-1167 minimal proxies point at their implementation', async () => {
    const minimal = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3';
    const http = fakeHttp(evmNode('mainnet.base.org', { code: minimal, implCode: bytecode([...ERC20, '4e6ec247']) }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ hasMintFunction: true });
  });

  it('no contract code → null; transport failure everywhere → null with lastError', async () => {
    expect(await createEvm(testEnv(), fakeHttp(evmNode('mainnet.base.org', { code: '0x' }))).tokenBasics('base', TOKEN)).toBeNull();
    const evm = createEvm(testEnv(), fakeHttp(() => ({ status: 502, text: 'bad gateway' })));
    expect(await evm.tokenBasics('base', TOKEN)).toBeNull();
    expect(evm.lastError).toMatch(/HTTP 502/);
  });

  describe('a call the node did not run is a failed read, never "no owner function"', () => {
    const OWNER_SEL = '0x8da5cb5b';
    const GET_OWNER_SEL = '0x893d20e8';
    /** owner() (and getOwner()) answered by `answer`; everything else as a plain ERC-20 with an owner selector */
    const node = (answer: (id: number) => ReturnType<Handler>, selectors = [...ERC20, '8da5cb5b']) =>
      fakeHttp(
        (url, _req, body) => {
          const b = body as { id: number; method: string; params: [{ data?: string }] };
          if (url.host !== 'mainnet.base.org' || b.method !== 'eth_call') return undefined;
          return [OWNER_SEL, GET_OWNER_SEL].includes(b.params[0].data ?? '') ? answer(b.id) : undefined;
        },
        evmNode('mainnet.base.org', { code: bytecode(selectors), calls: { '0x313ce567': encUint(18) } }),
      );

    it.each([
      ['HTTP 429 with a JSON-RPC body', (id: number) => ({ status: 429, json: { jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limit exceeded' } } })],
      ['a 200 -32005 envelope', (id: number) => ({ json: { jsonrpc: '2.0', id, error: { code: -32005, message: 'limit exceeded' } } })],
      ['-32000 header not found', (id: number) => ({ json: { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } } })],
      ['-32603 internal error', (id: number) => ({ json: { jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } } })],
      ['HTTP 503 without a body', () => ({ status: 503, text: 'busy' })],
    ])('%s on owner(): reported, owner unknown', async (_label, answer) => {
      const evm = createEvm(testEnv(), node(answer as (id: number) => ReturnType<Handler>));
      const { value, errors } = await captureErrors(() => evm.tokenBasics('base', TOKEN));
      expect(value).toMatchObject({ owner: null, ownerRenounced: null, decimals: 18 });
      expect(errors).toEqual([expect.stringMatching(/^evm\.tokenBasics owner base: /)]);
    });

    it.each([
      ['code 3', { code: 3, message: 'execution reverted' }],
      ['-32000 execution reverted (geth without revert data)', { code: -32000, message: 'execution reverted' }],
      ['-32015 VM execution error (Nethermind)', { code: -32015, message: 'VM execution error.', data: 'revert' }],
      ['-32000 invalid opcode', { code: -32000, message: 'invalid opcode: INVALID' }],
    ])('a genuine revert (%s) is still "no owner function"', async (_label, error) => {
      // no owner selector in the bytecode: both reverts are answers, so the token counts as renounced
      const evm = createEvm(testEnv(), node(id => ({ json: { jsonrpc: '2.0', id, error } }), ERC20));
      const { value, errors } = await captureErrors(() => evm.tokenBasics('base', TOKEN));
      expect(errors).toEqual([]);
      expect(value).toMatchObject({ owner: null, ownerRenounced: true });
    });

    it('a failed EIP-1967 slot read is reported: no implementation, mint function unknown (not "none")', async () => {
      const http = fakeHttp(
        evmNode('mainnet.base.org', {
          code: '0x363d3d37' + 'aa'.repeat(40),
          extra: { eth_getStorageAt: () => ({ error: { code: -32005, message: 'rate limit exceeded' } }) },
        }),
      );
      const evm = createEvm(testEnv(), http);
      const { value, errors } = await captureErrors(() => evm.tokenBasics('base', TOKEN));
      expect(value).toMatchObject({ implementation: null, hasMintFunction: null, ownerRenounced: null });
      expect(errors).toEqual([expect.stringMatching(/^evm\.implementation base: rate limit exceeded/)]);
    });

    it("the implementation's code not read: reported, mint function unknown", async () => {
      const http = fakeHttp(
        evmNode('mainnet.base.org', {
          code: '0x363d3d37' + 'aa'.repeat(40),
          storage: encAddress(IMPL),
          extra: { eth_getCode: p => ((p[0] as string).toLowerCase() === IMPL ? { error: { code: -32000, message: 'missing trie node' } } : '0x363d3d37' + 'aa'.repeat(40)) },
        }),
      );
      const { value, errors } = await captureErrors(() => createEvm(testEnv(), http).tokenBasics('base', TOKEN));
      expect(value).toMatchObject({ implementation: IMPL, hasMintFunction: null });
      expect(errors).toEqual([expect.stringMatching(/^evm\.getCode base: missing trie node/)]);
    });
  });

  it('the implementation behind a proxy is returned: EIP-1967 slot, EIP-1167 target, EIP-1967 beacon', async () => {
    const proxy = '0x363d3d37' + 'aa'.repeat(40);
    const slot = createEvm(testEnv(), fakeHttp(evmNode('mainnet.base.org', { code: proxy, storage: encAddress(IMPL), implCode: bytecode(ERC20) })));
    expect(await slot.tokenBasics('base', TOKEN)).toMatchObject({ implementation: IMPL, hasMintFunction: false });

    const minimal = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3';
    const clone = createEvm(testEnv(), fakeHttp(evmNode('mainnet.base.org', { code: minimal, implCode: bytecode(ERC20) })));
    expect(await clone.tokenBasics('base', TOKEN)).toMatchObject({ implementation: IMPL });

    // a beacon proxy: the implementation slot is empty, the beacon slot names the beacon, whose implementation() is the logic
    const BEACON = '0x' + 'be'.repeat(20);
    const http = fakeHttp(
      rpcHandler('mainnet.base.org', {
        eth_getCode: p => ((p[0] as string).toLowerCase() === IMPL ? bytecode([...ERC20, '40c10f19']) : proxy),
        eth_getStorageAt: p => (p[1] === EIP1967_BEACON_SLOT ? encAddress(BEACON) : '0x' + '0'.repeat(64)),
        eth_call: p => {
          const { to, data } = p[0] as { to: string; data: string };
          if (to.toLowerCase() === BEACON && data === '0x5c60da1b') return encAddress(IMPL);
          return { error: { code: 3, message: 'execution reverted' } };
        },
      }),
    );
    const { value, errors } = await captureErrors(() => createEvm(testEnv(), http).tokenBasics('base', TOKEN));
    expect(errors).toEqual([]);
    expect(value).toMatchObject({ implementation: IMPL, hasMintFunction: true });
    const slots = http.calls.filter(c => (c.body as { method: string }).method === 'eth_getStorageAt').map(c => (c.body as { params: unknown[] }).params[1]);
    expect(slots.sort()).toEqual([EIP1967_IMPL_SLOT, EIP1967_BEACON_SLOT, ZEPPELINOS_IMPL_SLOT, EIP1822_PROXIABLE_SLOT].sort());
  });

  it("USDC (Circle's FiatTokenProxy): the implementation in the ZeppelinOS slot is read, so its mint() is seen", async () => {
    // only the legacy slot is set; owner() and decimals() answer through the proxy
    const http = fakeHttp(
      evmNode('mainnet.base.org', {
        code: PROXY_CODE,
        slots: { [ZEPPELINOS_IMPL_SLOT]: encAddress(IMPL) },
        implCode: bytecode([...ERC20, '40c10f19', '8da5cb5b', '4e44d956']),
        calls: { '0x95d89b41': encString('USDC'), '0x313ce567': encUint(6), '0x8da5cb5b': encAddress(OWNER) },
      }),
    );
    const { value, errors } = await captureErrors(() => createEvm(testEnv(), http).tokenBasics('base', TOKEN));
    expect(errors).toEqual([]);
    expect(value).toMatchObject({ symbol: 'USDC', decimals: 6, implementation: IMPL, hasMintFunction: true, owner: OWNER, ownerRenounced: false });
  });

  it('EIP-1822 (UUPS, PROXIABLE slot): the implementation is read', async () => {
    const http = fakeHttp(
      evmNode('mainnet.base.org', { code: PROXY_CODE, slots: { [EIP1822_PROXIABLE_SLOT]: encAddress(IMPL) }, implCode: bytecode([...ERC20, 'a0712d68']) }),
    );
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ implementation: IMPL, hasMintFunction: true });
  });

  it('a proxy whose implementation is in no slot we know: mint unknown, never "no mint function"', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: PROXY_CODE, calls: { '0x313ce567': encUint(6), '0x8da5cb5b': encAddress(OWNER) } }));
    const { value, errors } = await captureErrors(() => createEvm(testEnv(), http).tokenBasics('base', TOKEN));
    expect(errors).toEqual([]);
    expect(value).toMatchObject({ implementation: null, hasMintFunction: null, owner: OWNER, ownerRenounced: false });
    // and without owner(): who controls it is unknown too, not "renounced"
    const ownerless = fakeHttp(evmNode('mainnet.base.org', { code: PROXY_CODE }));
    expect(await createEvm(testEnv(), ownerless).tokenBasics('base', TOKEN)).toMatchObject({ hasMintFunction: null, ownerRenounced: null });
  });

  it('a full token that DELEGATECALLs itself (Multicall) is not a proxy: no mint selector still reads "no mint function"', async () => {
    const code = bytecode([...ERC20, 'ac9650d8']) + '5af4';
    const http = fakeHttp(evmNode('mainnet.base.org', { code }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ implementation: null, hasMintFunction: false, ownerRenounced: true });
  });

  it("USDT's issue(uint256) counts as a mint function", async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode([...ERC20, 'cc872b66', '8da5cb5b']), calls: { '0x8da5cb5b': encAddress(OWNER) } }));
    expect(await createEvm(testEnv(), http).tokenBasics('base', TOKEN)).toMatchObject({ hasMintFunction: true, ownerRenounced: false });
  });

  it('chain without an RPC → null, no request', async () => {
    const http = fakeHttp();
    expect(await createEvm(testEnv(), http).tokenBasics('rh', TOKEN)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('EVM adapter: simulate (never broadcast)', () => {
  const tx = { from: '0x00000000000000000000000000000000000b0b00', to: TOKEN, data: '0xa9059cbb' + word('01') + word('02'), value: '1000000000000000000' };

  it('eth_call + eth_estimateGas; ok with the gas estimate', async () => {
    const http = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: () => '0x', eth_estimateGas: () => '0x5208' }));
    expect(await createEvm(testEnv(), http).simulate('base', tx)).toEqual({ ok: true, error: null, gas: '21000' });
    const methods = http.calls.map(c => (c.body as { method: string }).method);
    expect(methods).toEqual(['eth_call', 'eth_estimateGas']);
    expect((http.calls[0].body as { params: unknown[] }).params).toEqual([
      { from: tx.from, to: TOKEN, data: tx.data, value: '0xde0b6b3a7640000' },
      'latest',
    ]);
  });

  it('decodes Error(string) and Panic(uint256) revert reasons', async () => {
    const reason = '0x08c379a0' + encString('ERC20: transfer amount exceeds balance').slice(2);
    const http = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: () => ({ error: { code: 3, message: 'execution reverted', data: reason } }) }));
    expect(await createEvm(testEnv(), http).simulate('base', tx)).toEqual({ ok: false, error: 'ERC20: transfer amount exceeds balance', gas: null });
    expect(decodeRevert('0x4e487b71' + word('11'))).toBe('panic 0x11');
    const http2 = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: () => '0x', eth_estimateGas: () => ({ error: { code: -32000, message: 'execution reverted: Trading not open' } }) }));
    expect(await createEvm(testEnv(), http2).simulate('base', tx)).toEqual({ ok: false, error: 'Trading not open', gas: null });
  });

  it('never builds eth_sendTransaction / eth_sendRawTransaction', async () => {
    const http = fakeHttp(evmNode('mainnet.base.org', { code: bytecode(ERC20), extra: { eth_estimateGas: () => '0x1' } }));
    const evm = createEvm(testEnv({ ETHERSCAN_API_KEY: 'k' }), http);
    await evm.detectChain(TOKEN);
    await evm.getCode('base', TOKEN);
    await evm.tokenBasics('base', TOKEN);
    await evm.simulate('base', tx);
    await evm.simulate('base', { from: tx.from, to: TOKEN });
    await evm.creator('base', TOKEN);
    const sent = http.calls.map(c => JSON.stringify(c.body ?? ''));
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.some(b => /eth_send|sendTransaction|sendRawTransaction/i.test(b))).toBe(false);
    for (const m of EVM_READ_METHODS) expect(m).not.toMatch(/send/i);
  });

  it('the JSON-RPC layer refuses send methods before any request is made', async () => {
    const http = fakeHttp(() => ({ json: { jsonrpc: '2.0', id: 1, result: '0xhash' } }));
    await expect(jsonRpc(http, 'https://mainnet.base.org', 'eth_sendRawTransaction', ['0xf86c'], EVM_READ_METHODS)).rejects.toThrow(/not allowed/);
    await expect(jsonRpc(http, 'https://mainnet.base.org', 'eth_sendTransaction', [{}], EVM_READ_METHODS)).rejects.toThrow(/not allowed/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('EVM adapter: creator (Etherscan V2)', () => {
  it('stub without ETHERSCAN_API_KEY: null and no request', async () => {
    const http = fakeHttp();
    expect(await createEvm(testEnv(), http).creator('base', TOKEN)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('calls getcontractcreation with the chain id and maps the result', async () => {
    const http = fakeHttp(url =>
      url.host === 'api.etherscan.io'
        ? {
            json: {
              status: '1',
              message: 'OK',
              result: [{ contractAddress: TOKEN, contractCreator: '0xABCDEF0000000000000000000000000000000001', txHash: '0xfeed', blockNumber: '123', timestamp: '1760054400' }],
            },
          }
        : undefined,
    );
    const c = await createEvm(testEnv({ ETHERSCAN_API_KEY: 'sekret key' }), http).creator('base', TOKEN);
    expect(c).toEqual({ creator: '0xabcdef0000000000000000000000000000000001', txHash: '0xfeed', createdAt: '2025-10-10T00:00:00.000Z' });
    const u = new URL(http.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.etherscan.io/v2/api');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      chainid: '8453', module: 'contract', action: 'getcontractcreation', contractaddresses: TOKEN, apikey: 'sekret key',
    });
  });

  it('Etherscan error answers → null with lastError (the key never appears in it)', async () => {
    const http = fakeHttp(() => ({ json: { status: '0', message: 'NOTOK', result: 'Invalid API Key' } }));
    const evm = createEvm(testEnv({ ETHERSCAN_API_KEY: 'sekret' }), http);
    expect(await evm.creator('eth', TOKEN)).toBeNull();
    expect(evm.lastError).toBe('evm.creator: Invalid API Key');
  });

  it('Robinhood Chain has no Etherscan chain id → null', async () => {
    expect(await createEvm(testEnv({ ETHERSCAN_API_KEY: 'k', RPC_ROBINHOOD: 'https://rh' }), fakeHttp()).creator('rh', TOKEN)).toBeNull();
  });
});

describe('ABI helpers', () => {
  it('strings: dynamic, bytes32, garbage', () => {
    expect(decodeAbiString(encString('Hello'))).toBe('Hello');
    expect(decodeAbiString(encString('x'.repeat(70)))).toBe('x'.repeat(70));
    expect(decodeAbiString(encBytes32('MKR'))).toBe('MKR');
    expect(decodeAbiString('0x')).toBeNull();
    expect(decodeAbiString('0x1234')).toBeNull();
  });
  it('selector scan walks opcodes', () => {
    const s = bytecodeSelectors(bytecode(['40c10f19'], { hideMintInPushData: false }));
    expect(s.has('40c10f19')).toBe(true);
    expect(bytecodeSelectors(bytecode([], { hideMintInPushData: true })).has('40c10f19')).toBe(false);
  });
  it('proxy slots and mint selectors are the keccak256 of what they name', () => {
    const minus1 = (h: string) => '0x' + (BigInt('0x' + h) - 1n).toString(16).padStart(64, '0');
    expect(EIP1967_IMPL_SLOT).toBe(minus1(keccak256('eip1967.proxy.implementation')));
    expect(EIP1967_BEACON_SLOT).toBe(minus1(keccak256('eip1967.proxy.beacon')));
    expect(ZEPPELINOS_IMPL_SLOT).toBe('0x' + keccak256('org.zeppelinos.proxy.implementation'));
    expect(EIP1822_PROXIABLE_SLOT).toBe('0x' + keccak256('PROXIABLE'));
    expect(MINT_SELECTORS).toEqual(
      ['mint(address,uint256)', 'mint(uint256)', '_mint(address,uint256)', 'mintTo(address,uint256)', 'issue(uint256)'].map(selector),
    );
  });
  it('looksLikeProxy: DELEGATECALL in code without the ERC-20 dispatcher', () => {
    expect(looksLikeProxy(PROXY_CODE)).toBe(true);
    expect(looksLikeProxy('0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3')).toBe(true);
    expect(looksLikeProxy(bytecode(ERC20) + '5af4')).toBe(false);
    expect(looksLikeProxy(bytecode(['f851a440']))).toBe(false);
    // 0xf4 inside PUSH data is not an opcode
    expect(looksLikeProxy('0x6080604052' + '63f4f4f4f4' + '00')).toBe(false);
    expect(looksLikeProxy(null)).toBe(false);
  });
  it('ownerlessRenounced: true only for known bytecode with no owner, role or mint selector', () => {
    expect(ownerlessRenounced(bytecode(ERC20), false)).toBe(true);
    expect(ownerlessRenounced(bytecode([...ERC20, '40c10f19']), true)).toBeNull();
    for (const role of ['91d14854', '2f2ff15d', '248a9ca3', 'd547741f', 'd5391393', 'bf7e214f', 'aa271e1a', '983b2d56', '8da5cb5b']) {
      expect(ownerlessRenounced(bytecode([...ERC20, role]), false)).toBeNull();
    }
    expect(ownerlessRenounced(null, null)).toBeNull();
    expect(ownerlessRenounced(bytecode(ERC20), null)).toBeNull();
  });
});
