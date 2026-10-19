/**
 * Wallet discovery and the sign-in flow with fake providers (no browser): EIP-6963 announcements and the
 * window.ethereum fallback, the Wallet Standard handshake and the window.phantom.solana fallback, then
 * connect → nonce → sign → verify for each, and how declines and API errors read.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthNonceResponse, AuthVerifyBody, MeDTO } from '@apecheck/core';
import { ApiRequestError } from '@/lib/api';
import {
  WalletFlowError,
  createWalletRegistry,
  hexUtf8,
  isUserRejection,
  safeIcon,
  signInErrorText,
  toBase58,
  walletSignIn,
  type SignInApi,
  type WalletWindow,
} from '@/lib/wallet';

const EVM = '0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A';
const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

type FakeWin = WalletWindow & EventTarget & Record<string, unknown>;
const fakeWindow = (extra: Record<string, unknown> = {}): FakeWin => Object.assign(new EventTarget(), extra) as FakeWin;

interface Call {
  method: string;
  params?: unknown;
}
function fakeEvm(o: { accounts?: unknown; chainId?: unknown; sign?: (params: unknown) => unknown; flags?: Record<string, boolean> } = {}) {
  const calls: Call[] = [];
  return {
    ...o.flags,
    calls,
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts') return o.accounts ?? [EVM];
      if (method === 'eth_chainId') {
        if (o.chainId instanceof Error) throw o.chainId;
        return o.chainId ?? '0x2105';
      }
      if (method === 'personal_sign') return o.sign ? o.sign(params) : '0x' + 'ab'.repeat(65);
      throw Object.assign(new Error('unsupported'), { code: 4200 });
    },
  };
}

/** A wallet that answers eip6963:requestProvider like a real extension. */
function announces(win: FakeWin, info: Record<string, unknown>, provider: unknown) {
  win.addEventListener('eip6963:requestProvider', () => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } })));
}

/** ed25519 key from a fixed seed, and its base58 address. */
function edKey(seedByte: number) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key);
  const raw = pub.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { key, pub, address: toBase58(raw), raw };
}

/** A Wallet Standard wallet that signs with node:crypto. */
function standardWallet(name: string, seedByte = 7, o: { noSign?: boolean; reject?: unknown; badSig?: boolean } = {}) {
  const k = edKey(seedByte);
  const account = { address: k.address, publicKey: new Uint8Array(k.raw), chains: ['solana:mainnet'], features: ['solana:signMessage'] };
  const seen: { account?: unknown; message?: Uint8Array } = {};
  const features: Record<string, unknown> = {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
  };
  if (!o.noSign) {
    features['solana:signMessage'] = {
      version: '1.0.0',
      signMessage: async (input: { account: unknown; message: Uint8Array }) => {
        if (o.reject) throw o.reject;
        seen.account = input.account;
        seen.message = input.message;
        const sig = o.badSig ? new Uint8Array(63) : new Uint8Array(edSign(null, input.message, k.key));
        return [{ signedMessage: input.message, signature: sig }];
      },
    };
  }
  return { wallet: { version: '1.0.0', name, icon: ICON, chains: ['solana:mainnet'], accounts: [] as unknown[], features }, account, seen, key: k };
}

function fakeApi(message = 'apecheck.io wants you to sign in…\nNonce: abc12345') {
  const nonce = vi.fn(async (..._args: [string, string, (number | null)?]) => ({ nonce: 'abc12345', message, expiresAt: new Date().toISOString() }) as AuthNonceResponse);
  const verify = vi.fn(async (_b: AuthVerifyBody) => ({ tier: 'free', user: { id: 'u1' } }) as unknown as MeDTO);
  return { api: { nonce, verify } as SignInApi, nonce, verify, message };
}

describe('encoding', () => {
  it('hex-encodes the UTF-8 bytes of the message for personal_sign', () => {
    expect(hexUtf8('Hi é')).toBe('0x4869' + '20' + 'c3a9');
  });
  it('base58 like Solana addresses', () => {
    expect(toBase58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(toBase58(Uint8Array.from([0, 0, 1]))).toBe('112');
  });
  it('renders only data: image icons', () => {
    expect(safeIcon(ICON)).toBe(ICON);
    expect(safeIcon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeIcon('https://evil.example/icon.svg')).toBeNull();
    expect(safeIcon('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeIcon('javascript:alert(1)')).toBeNull();
    expect(safeIcon(42)).toBeNull();
  });
});

describe('EVM discovery', () => {
  it('lists every EIP-6963 wallet once, with name, rdns and only a data: icon', () => {
    const win = fakeWindow();
    announces(win, { uuid: 'u-1', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }, fakeEvm());
    announces(win, { uuid: 'u-2', name: 'Rabby', icon: 'https://rabby.io/logo.png', rdns: 'io.rabby' }, fakeEvm());
    // not a provider: ignored
    announces(win, { uuid: 'u-3', name: 'Broken', icon: ICON, rdns: 'x' }, { notRequest: true });
    const reg = createWalletRegistry(win);
    reg.refresh(); // the same wallets answer again
    expect(reg.list().map(o => [o.name, o.chain, o.via, o.rdns, o.icon])).toEqual([
      ['MetaMask', 'evm', 'eip6963', 'io.metamask', ICON],
      ['Rabby', 'evm', 'eip6963', 'io.rabby', null],
    ]);
  });

  it('a wallet that announces later shows up and notifies subscribers', () => {
    const win = fakeWindow();
    const reg = createWalletRegistry(win);
    const fn = vi.fn();
    reg.subscribe(fn);
    expect(reg.list()).toEqual([]);
    win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'late', name: 'Late Wallet', icon: ICON, rdns: 'late' }, provider: fakeEvm() } }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reg.list().map(o => o.name)).toEqual(['Late Wallet']);
  });

  it('falls back to window.ethereum (named by its flags) only while no wallet announced', () => {
    const win = fakeWindow({ ethereum: fakeEvm({ flags: { isRabby: true, isMetaMask: true } }) });
    const reg = createWalletRegistry(win);
    expect(reg.list().map(o => [o.name, o.via])).toEqual([['Rabby', 'injected']]);
    expect(reg.list()[0]).toBe(reg.list()[0]); // stable key across renders
    win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'mm', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }, provider: fakeEvm() } }));
    expect(reg.list().map(o => o.name)).toEqual(['MetaMask']);
  });
});

describe('Solana discovery', () => {
  it('registers wallets that loaded first (app-ready) and later (register-wallet), skipping ones that cannot sign messages', () => {
    const win = fakeWindow();
    const early = standardWallet('Phantom', 1);
    win.addEventListener('wallet-standard:app-ready', e => (e as CustomEvent<{ register(...w: unknown[]): () => void }>).detail.register(early.wallet));
    const reg = createWalletRegistry(win);
    const late = standardWallet('Solflare', 2);
    let unregister: () => void = () => {};
    win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }: { register(...w: unknown[]): () => void }) => (unregister = register(late.wallet)) }));
    const evmOnly = standardWallet('EVM Only', 3, { noSign: true });
    win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }: { register(...w: unknown[]): () => void }) => register(evmOnly.wallet) }));
    expect(reg.list('sol').map(o => [o.name, o.via, o.icon])).toEqual([
      ['Phantom', 'standard', ICON],
      ['Solflare', 'standard', ICON],
    ]);
    unregister();
    expect(reg.list('sol').map(o => o.name)).toEqual(['Phantom']);
    expect(reg.list('evm')).toEqual([]);
  });

  it('falls back to window.phantom.solana when no standard wallet registered', () => {
    const legacy = { isPhantom: true, connect: async () => ({}), signMessage: async () => ({}) };
    const reg = createWalletRegistry(fakeWindow({ phantom: { solana: legacy }, solana: { connect: () => {}, signMessage: () => {} } }));
    expect(reg.list().map(o => [o.name, o.chain, o.via])).toEqual([['Phantom', 'sol', 'legacy']]);
  });
});

describe('walletSignIn', () => {
  it('EVM: eth_requestAccounts → nonce with the chain id → personal_sign [hex message, address] → verify', async () => {
    const provider = fakeEvm({ sign: () => '0x' + '12'.repeat(65) });
    const win = fakeWindow();
    announces(win, { uuid: 'u', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }, provider);
    const [opt] = createWalletRegistry(win).list();
    const { api, nonce, verify, message } = fakeApi();
    const steps: string[] = [];
    const me = await walletSignIn(opt, api, s => steps.push(s));
    expect(me.user?.id).toBe('u1');
    expect(steps).toEqual(['connect', 'sign', 'verify']);
    expect(nonce).toHaveBeenCalledWith('evm', EVM, 8453);
    expect(provider.calls.find(c => c.method === 'personal_sign')?.params).toEqual([hexUtf8(message), EVM]);
    expect(verify).toHaveBeenCalledWith({ chain: 'evm', address: EVM, message, signature: '0x' + '12'.repeat(65) });
  });

  it('EVM: a wallet that cannot say its chain signs for chain 1 (the API default)', async () => {
    const win = fakeWindow({ ethereum: fakeEvm({ chainId: new Error('nope') }) });
    const [opt] = createWalletRegistry(win).list();
    const { api, nonce } = fakeApi();
    await walletSignIn(opt, api);
    expect(nonce).toHaveBeenCalledWith('evm', EVM, null);
  });

  it('Solana (Wallet Standard): signs the UTF-8 message with the account the wallet handed out; the signature verifies', async () => {
    const win = fakeWindow();
    const w = standardWallet('Phantom', 9);
    win.addEventListener('wallet-standard:app-ready', e => (e as CustomEvent<{ register(...x: unknown[]): () => void }>).detail.register(w.wallet));
    const [opt] = createWalletRegistry(win).list('sol');
    const { api, nonce, verify, message } = fakeApi('apecheck.io wants you to sign in with your Solana account:\nNonce: zzz99999');
    await walletSignIn(opt, api);
    expect(nonce).toHaveBeenCalledWith('sol', w.key.address, null);
    expect(w.seen.account).toBe(w.account);
    expect(Buffer.from(w.seen.message!).toString('utf8')).toBe(message);
    const body = verify.mock.calls[0][0];
    expect(body).toMatchObject({ chain: 'sol', address: w.key.address, message });
    const sig = Buffer.from(body.signature, 'base64');
    expect(sig.length).toBe(64);
    expect(edVerify(null, Buffer.from(message, 'utf8'), w.key.pub, sig)).toBe(true);
  });

  it('Solana (window.phantom.solana): connect → publicKey, signMessage(bytes, "utf8")', async () => {
    const k = edKey(5);
    const signMessage = vi.fn(async (m: Uint8Array, _display?: string) => ({ signature: new Uint8Array(edSign(null, m, k.key)) }));
    const legacy = { isPhantom: true, connect: async () => ({ publicKey: { toBase58: () => k.address, toString: () => k.address } }), signMessage };
    const [opt] = createWalletRegistry(fakeWindow({ phantom: { solana: legacy } })).list();
    const { api, verify, message } = fakeApi();
    await walletSignIn(opt, api);
    expect(signMessage.mock.calls[0][1]).toBe('utf8');
    const sig = Buffer.from(verify.mock.calls[0][0].signature, 'base64');
    expect(edVerify(null, Buffer.from(message), k.pub, sig)).toBe(true);
  });

  it('a declined signature (4001) never reaches verify and reads "Signature request was declined"', async () => {
    const win = fakeWindow({
      ethereum: fakeEvm({
        sign: () => {
          throw Object.assign(new Error('MetaMask Tx Signature: User denied message signature.'), { code: 4001 });
        },
      }),
    });
    const [opt] = createWalletRegistry(win).list();
    const { api, verify } = fakeApi();
    const err = await walletSignIn(opt, api).catch(e => e);
    expect(err).toBeInstanceOf(WalletFlowError);
    expect(err.code).toBe('declined_sign');
    expect(signInErrorText(err)).toBe('Signature request was declined');
    expect(verify).not.toHaveBeenCalled();
  });

  it('a Solana wallet that rejects in plain words is a decline too; a short signature is refused', async () => {
    for (const [o, code] of [
      [{ reject: new Error('User rejected the request.') }, 'declined_sign'],
      [{ badSig: true }, 'bad_signature'],
    ] as const) {
      const win = fakeWindow();
      const w = standardWallet('Phantom', 3, o);
      win.addEventListener('wallet-standard:app-ready', e => (e as CustomEvent<{ register(...x: unknown[]): () => void }>).detail.register(w.wallet));
      const [opt] = createWalletRegistry(win).list();
      const err = await walletSignIn(opt, fakeApi().api).catch(e => e);
      expect(err.code).toBe(code);
    }
  });

  it('connect: declined, a request already open, no account', async () => {
    const cases: [unknown, string, string][] = [
      [Object.assign(new Error('User rejected the request.'), { code: 4001 }), 'declined_connect', 'Connection request was declined'],
      [Object.assign(new Error('Request of type wallet_requestPermissions already pending'), { code: -32002 }), 'pending', 'Your wallet already has a request open. Check it and try again.'],
    ];
    for (const [thrown, code, text] of cases) {
      const provider = {
        request: async () => {
          throw thrown;
        },
      };
      const [opt] = createWalletRegistry(fakeWindow({ ethereum: provider })).list();
      const err = await walletSignIn(opt, fakeApi().api).catch(e => e);
      expect(err.code).toBe(code);
      expect(signInErrorText(err)).toBe(text);
    }
    const [opt] = createWalletRegistry(fakeWindow({ ethereum: fakeEvm({ accounts: [] }) })).list();
    expect((await walletSignIn(opt, fakeApi().api).catch(e => e)).code).toBe('no_account');
  });

  it("API failures pass the API's words through (409 wallet_taken)", async () => {
    const [opt] = createWalletRegistry(fakeWindow({ ethereum: fakeEvm() })).list();
    const api: SignInApi = {
      nonce: fakeApi().api.nonce,
      verify: async () => {
        throw new ApiRequestError(409, { code: 'wallet_taken', error: 'This wallet is linked to another ApeCheck account.' });
      },
    };
    const err = await walletSignIn(opt, api).catch(e => e);
    expect(signInErrorText(err)).toBe('This wallet is linked to another ApeCheck account.');
  });

  it('recognises rejections across wallets', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true);
    expect(isUserRejection({ message: 'Approval Denied' })).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error('Internal JSON-RPC error.'))).toBe(false);
  });
});
