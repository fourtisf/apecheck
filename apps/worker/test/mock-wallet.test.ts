/**
 * Mock wallet + browser isolation in real Chromium: EIP-1193 / EIP-6963 provider, Solana injection and
 * Wallet Standard registration, requests recorded in Node, transactions captured and rejected, and the
 * context.route guard refusing private / non-http targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_EVM_RPC, type HttpRequest } from '@apecheck/sources';
import { BrowserHost, type BrowseSession } from '../src/browser/browser';
import { BURNER_EVM, BURNER_SOL, WalletRecorder, base58, chainFromHex, evmChainIdHex } from '../src/browser/mock-wallet';
import { readRpcFor } from '../src/pipeline/browse';
import { serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { fakeSources } from './fakes';
import { standaloneRun, testEnv } from './helpers';

let host: BrowserHost;
let site: FixtureSite;
let session: BrowseSession;

beforeAll(async () => {
  site = await serveFixture('working-app');
  const env = testEnv({ SSRF_ALLOW_HOSTS: site.host });
  host = await BrowserHost.launch({ env, lookup: testLookup });
  session = await host.newSession({ evmChainId: evmChainIdHex('base') });
  const page = await session.newPage();
  await page.goto(site.url);
});

afterAll(async () => {
  await session?.close();
  await host?.close();
  await site?.close();
});

const run = <T>(js: string): Promise<T> => session.page!.evaluate(js) as Promise<T>;

describe('mock wallet', () => {
  it('burner keys are well formed', () => {
    expect(BURNER_EVM).toMatch(/^0x[0-9a-f]{40}$/);
    expect(BURNER_EVM).not.toBe('0x000000000000000000000000000000000000dead');
    expect(BURNER_SOL).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(chainFromHex('0x2105')).toBe('base');
    expect(evmChainIdHex('bnb')).toBe('0x38');
  });

  it('EIP-1193: accounts, chain, switching and signing are answered and recorded', async () => {
    expect(await run('window.ethereum.isMetaMask')).toBe(true);
    expect(await run(`window.ethereum.request({ method: 'eth_accounts' })`)).toEqual([]);
    expect(await run(`window.ethereum.request({ method: 'eth_requestAccounts' })`)).toEqual([BURNER_EVM]);
    expect(session.wallet.requested).toBe(true);
    expect(session.wallet.connected).toBe(true);
    expect(await run(`window.ethereum.request({ method: 'eth_chainId' })`)).toBe('0x2105');
    await run(`window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })`);
    expect(await run(`window.ethereum.request({ method: 'eth_chainId' })`)).toBe('0x1');
    const sig = await run<string>(`window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', '${BURNER_EVM}'] })`);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    const typed = await run<string>(`window.ethereum.request({ method: 'eth_signTypedData_v4', params: ['${BURNER_EVM}', '{}'] })`);
    expect(typed).toHaveLength(132);
    expect([...session.wallet.methods]).toEqual(expect.arrayContaining(['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign', 'eth_signTypedData_v4']));
    expect(session.wallet.signatures).toBe(2);
  });

  it('eth_sendTransaction is captured, never sent, and rejected with 4001', async () => {
    const res = await run<{ code: number; message: string }>(`window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: '0x0000000000000000000000000000000000000001', to: '0x2626664c2603336e57b271c5c0b26f421741e481', data: '0xdeadbeef', value: '0x10' }] }).then(() => ({ code: 0 }), e => ({ code: e.code, message: e.message }))`);
    expect(res.code).toBe(4001);
    const tx = session.wallet.txs.at(-1)!;
    expect(tx.kind).toBe('evm');
    expect(tx.chainId).toBe('0x1');
    // whatever the page claims, the sender is the burner
    expect(tx.evm).toEqual({ from: BURNER_EVM, to: '0x2626664c2603336e57b271c5c0b26f421741e481', data: '0xdeadbeef', value: '0x10', gas: null });
  });

  it('EIP-6963 announces the provider', async () => {
    const info = await run<{ rdns: string; name: string; same: boolean }>(`new Promise(res => {
      window.addEventListener('eip6963:announceProvider', e => res({ rdns: e.detail.info.rdns, name: e.detail.info.name, same: e.detail.provider === window.ethereum }), { once: true });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    })`);
    expect(info).toEqual({ rdns: 'io.metamask', name: 'MetaMask', same: true });
  });

  it('Solana: Phantom-style injection connects to the burner; signing is captured and rejected', async () => {
    expect(await run('window.phantom.solana === window.solana && window.solana.isPhantom')).toBe(true);
    const eager = await run(`window.solana.connect({ onlyIfTrusted: true }).then(() => 'connected', e => e.code)`);
    expect(eager).toBe(4001);
    expect(await run(`window.solana.connect().then(r => r.publicKey.toBase58())`)).toBe(BURNER_SOL);
    const before = session.wallet.txs.length;
    const code = await run(`window.solana.signTransaction(new Uint8Array([1, 2, 3])).then(() => 0, e => e.code)`);
    expect(code).toBe(4001);
    expect(session.wallet.txs.length).toBe(before + 1);
    expect(session.wallet.txs.at(-1)).toMatchObject({ kind: 'sol', method: 'signTransaction', base64: 'AQID' });
  });

  it('Wallet Standard: registers on app-ready and exposes connect / signTransaction / signAndSendTransaction', async () => {
    const w = await run<{ name: string; features: string[]; address: string; code: number }>(`new Promise(resolve => {
      const api = { register: async (wallet) => {
        const { accounts } = await wallet.features['standard:connect'].connect();
        const code = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({ transaction: new Uint8Array([9, 9]), account: accounts[0], chain: 'solana:mainnet' }).then(() => 0, e => e.code);
        resolve({ name: wallet.name, features: Object.keys(wallet.features), address: accounts[0].address, code });
        return () => {};
      } };
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
    })`);
    expect(w.name).toBe('Phantom');
    expect(w.features).toEqual(expect.arrayContaining(['standard:connect', 'standard:events', 'solana:signTransaction', 'solana:signAndSendTransaction']));
    expect(w.address).toBe(BURNER_SOL);
    expect(w.code).toBe(4001);
    expect(session.wallet.txs.at(-1)).toMatchObject({ kind: 'sol', method: 'solana:signAndSendTransaction', base64: 'CQk=' });
  });

  it('forged binding calls are validated and capped', async () => {
    const before = session.wallet.txs.length;
    await run(`window.__apecheckWallet({ kind: 'evm', method: 'eth_sendTransaction', tx: { to: 'not-an-address', data: 'zz' } })`);
    await run(`window.__apecheckWallet({ kind: 'nope', method: 1 })`);
    const tx = session.wallet.txs.at(-1)!;
    expect(session.wallet.txs.length).toBe(before + 1);
    expect(tx.evm).toMatchObject({ to: null, data: null });
  });
});

describe("the wallet's read RPC", () => {
  /** a check run whose http records every JSON-RPC call and answers it with `0x10` */
  function readsVia(over: Record<string, string> = {}) {
    const env = testEnv(over);
    const calls: { url: string; method: string }[] = [];
    const sources = fakeSources(env);
    sources.http = {
      ...sources.http,
      json: async <T>(url: string, req: HttpRequest = {}) => {
        calls.push({ url, method: (JSON.parse(String(req.body)) as { method: string }).method });
        return { jsonrpc: '2.0', id: 1, result: '0x10' } as T;
      },
    };
    return { run: standaloneRun({ env, sources, browser: null }).run, calls };
  }

  it('falls back to the public RPC of the chain when RPC_* is empty, like the EVM adapter', async () => {
    const { run, calls } = readsVia();
    // what a dApp's own eth_blockNumber / eth_getCode through the test wallet goes through
    const wallet = new WalletRecorder({ readRpc: readRpcFor(run) });
    expect(await wallet.handle({ kind: 'evm', read: true, method: 'eth_blockNumber', chainId: '0x2105', params: [] })).toEqual({ result: '0x10' });
    expect(await wallet.handle({ kind: 'evm', read: true, method: 'eth_getCode', chainId: '0xa4b1', params: [BURNER_EVM, 'latest'] })).toEqual({ result: '0x10' });
    expect(calls).toEqual([
      { url: PUBLIC_EVM_RPC.base, method: 'eth_blockNumber' },
      { url: PUBLIC_EVM_RPC.arb, method: 'eth_getCode' },
    ]);
    // a chain with neither a configured nor a public RPC is still refused
    expect(await wallet.handle({ kind: 'evm', read: true, method: 'eth_call', chainId: '0x7a69', params: [] })).toEqual({ error: 'no RPC for this chain' });
  });

  it('a configured RPC_* wins over the public one', async () => {
    const { run, calls } = readsVia({ RPC_BASE: 'https://base.example/KEY' });
    await readRpcFor(run)('0x2105', 'eth_blockNumber', []);
    expect(calls.map(c => c.url)).toEqual(['https://base.example/KEY']);
  });
});

describe('browser isolation', () => {
  it('requests to private / metadata addresses and non-http schemes are refused', async () => {
    const results = await run<string[]>(`Promise.all([
      fetch('http://169.254.169.254/latest/meta-data/').then(() => 'reached', () => 'blocked'),
      fetch('http://10.0.0.1/').then(() => 'reached', () => 'blocked'),
      fetch('http://127.0.0.1:${site.port}/').then(() => 'reached', () => 'blocked'),
    ])`);
    expect(results).toEqual(['blocked', 'blocked', 'blocked']);
    expect(session.blocked.map(b => b.url)).toEqual(expect.arrayContaining(['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', `http://127.0.0.1:${site.port}/`]));
    const p = await session.newPage();
    const nav = await p.goto('file:///etc/passwd').then(() => 'loaded', e => String(e));
    expect(nav).not.toBe('loaded');
    await p.close();
  });

  it('the guard proxy refuses private targets even without the route guard', async () => {
    // a context without route interception: only the proxy stands between the page and the fixture
    // server, which listens on 127.0.0.1 but is allow-listed only under its test host name
    const ctx = await host.browser.newContext();
    const p = await ctx.newPage();
    const res = await p.goto(`http://127.0.0.1:${site.port}/`);
    expect(res?.status()).toBe(403);
    expect(await p.textContent('body')).toMatch(/Blocked by ApeCheck SSRF guard/);
    const ok = await p.goto(site.url);
    expect(ok?.status()).toBe(200);
    await ctx.close();
  });
});
