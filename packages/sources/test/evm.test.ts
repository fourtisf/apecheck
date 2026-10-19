import { describe, expect, it } from 'vitest';
import { createEvm, EVM_READ_METHODS, PUBLIC_EVM_RPC } from '../src/adapters/evm';
import { bytecodeSelectors, decodeAbiString, decodeRevert, EIP1967_IMPL_SLOT, ownerlessRenounced } from '../src/abi';
import { jsonRpc } from '../src/rpc';
import { captureErrors } from '../src/util';
import { encAddress, encBytes32, encString, encUint, fakeHttp, rpcHandler, testEnv, word } from './helpers';

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

type Calls = Record<string, (params: unknown[]) => unknown>;
function evmNode(host: string, opts: { code?: string; calls?: Record<string, unknown>; storage?: string; implCode?: string; extra?: Calls }) {
  return rpcHandler(host, {
    eth_getCode: p => ((p[0] as string).toLowerCase() === IMPL ? opts.implCode ?? '0x' : opts.code ?? '0x'),
    eth_getStorageAt: () => opts.storage ?? '0x' + '0'.repeat(64),
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
