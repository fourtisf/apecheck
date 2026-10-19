/**
 * Fake wallets for the browser suite, injected before any page script runs:
 * - an EVM wallet announced through EIP-6963 (EIP-1193 provider) whose personal_sign is done in Node with
 *   @noble/curves secp256k1 (apps/api's copy) behind page.exposeFunction;
 * - a Solana wallet registered through the Wallet Standard ('standard:connect', 'solana:signMessage') whose
 *   signMessage is done in Node with node:crypto ed25519.
 * `window.__acWallets` in the page lets a test make the next request fail as a user rejection (`rejectNext`), or leave the
 * next EVM connect unanswered (`hangNext`, like a popup dismissed without rejecting) until it calls `release()`.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Page } from 'playwright';
import { REPO_ROOT } from './env';

// apps/api depends on @noble/curves + @noble/hashes; the web app doesn't, so load apps/api's copies
const apiRequire = createRequire(path.join(REPO_ROOT, 'apps/api/package.json'));
const { secp256k1 } = apiRequire('@noble/curves/secp256k1') as {
  secp256k1: {
    getPublicKey(priv: string | Uint8Array, compressed?: boolean): Uint8Array;
    sign(hash: Uint8Array, priv: string | Uint8Array): { r: bigint; s: bigint; recovery: number; toCompactRawBytes(): Uint8Array };
  };
};
const { keccak_256 } = apiRequire('@noble/hashes/sha3') as { keccak_256(b: Uint8Array): Uint8Array };

/* ---------- keys ---------- */

export function evmAddressOf(privHex: string): string {
  const pub = secp256k1.getPublicKey(privHex, false);
  return '0x' + Buffer.from(keccak_256(pub.subarray(1))).toString('hex').slice(-40);
}

/** personal_sign in Node: keccak256("\x19Ethereum Signed Message:\n" + len + bytes), 65 bytes r‖s‖v (v 27/28). */
export function personalSign(privHex: string, messageHex: string): string {
  const body = Buffer.from(messageHex.replace(/^0x/, ''), 'hex');
  const hash = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]));
  const sig = secp256k1.sign(hash, privHex);
  return '0x' + Buffer.from(sig.toCompactRawBytes()).toString('hex') + (27 + sig.recovery).toString(16);
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function solanaKey(seedHex: string) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { key, publicKey: new Uint8Array(pub), address: base58(pub) };
}

/* ---------- the suite's wallets ---------- */

/** Pro in the suite's TIER_OVERRIDES (follow-ups, notes, alerts). */
export const EVM_PRO_KEY = '11'.repeat(32);
/** Max in TIER_OVERRIDES (private checks). */
export const EVM_MAX_KEY = '22'.repeat(32);
export const SOL_SEED = '44'.repeat(32);

const ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6A3DF5"/><path d="M9 16l5 5 9-10" fill="none" stroke="#fff" stroke-width="3"/></svg>',
).toString('base64')}`;

export interface FakeWalletOpts {
  /** EVM private key (hex); null: no EVM wallet */
  evmKey?: string | null;
  /** Solana ed25519 seed (hex); null: no Solana wallet */
  solSeed?: string | null;
}

/** Installs the wallets on every page of `page`'s context navigation (call before page.goto). */
export async function installFakeWallets(page: Page, opts: FakeWalletOpts = {}) {
  const evmKey = opts.evmKey === undefined ? EVM_PRO_KEY : opts.evmKey;
  const solSeed = opts.solSeed === undefined ? SOL_SEED : opts.solSeed;
  const sol = solSeed ? solanaKey(solSeed) : null;

  if (evmKey) await page.exposeFunction('__acEvmSign', (messageHex: string) => personalSign(evmKey, messageHex));
  if (sol) {
    await page.exposeFunction('__acSolSign', (b64: string) => edSign(null, Buffer.from(b64, 'base64'), sol.key).toString('base64'));
  }

  const args = { evm: evmKey ? evmAddressOf(evmKey) : null, sol: sol ? { address: sol.address, publicKey: [...sol.publicKey] } : null, icon: ICON };
  // plain JS (not a serialized TS function): transpilers add helpers like __name that don't exist in the page
  await page.addInitScript({ content: `(${WALLETS_SCRIPT})(${JSON.stringify(args)});` });
}

/** Runs in the page before its own scripts: `({ evm, sol, icon }) => void`. */
const WALLETS_SCRIPT = String.raw`function (cfg) {
  var evm = cfg.evm, sol = cfg.sol, icon = cfg.icon;
  var state = { rejectNext: false, hangNext: false, requests: [], release: function () {} };
  window.__acWallets = state;
  function rejection() { var e = new Error('User rejected the request.'); e.code = 4001; return e; }

  if (evm) {
    var provider = {
      request: async function (args) {
        var method = args.method, params = args.params;
        state.requests.push(method);
        if (method === 'eth_requestAccounts' && state.hangNext) {
          state.hangNext = false;
          return new Promise(function (resolve) { state.release = function () { resolve([evm]); }; });
        }
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evm];
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'personal_sign') {
          if (state.rejectNext) { state.rejectNext = false; throw rejection(); }
          if (String(params[1]).toLowerCase() !== evm.toLowerCase()) throw new Error('wrong account');
          return window.__acEvmSign(params[0]);
        }
        var u = new Error('Unsupported method ' + method); u.code = 4200; throw u;
      },
    };
    var info = Object.freeze({ uuid: '6f0d3a52-0000-4000-8000-00000000e2e1', name: 'Test EVM Wallet', icon: icon, rdns: 'io.apecheck.test' });
    var announce = function () { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: provider }) })); };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }

  if (sol) {
    var toB64 = function (b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
    var fromB64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
    var account = Object.freeze({ address: sol.address, publicKey: new Uint8Array(sol.publicKey), chains: ['solana:mainnet'], features: ['solana:signMessage'] });
    var connected = false;
    var wallet = {
      version: '1.0.0',
      name: 'Test Solana Wallet',
      icon: icon,
      chains: ['solana:mainnet'],
      get accounts() { return connected ? [account] : []; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async function () { state.requests.push('standard:connect'); connected = true; return { accounts: [account] }; } },
        'standard:events': { version: '1.0.0', on: function () { return function () {}; } },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async function () {
            var inputs = Array.prototype.slice.call(arguments);
            state.requests.push('solana:signMessage');
            if (state.rejectNext) { state.rejectNext = false; throw rejection(); }
            return Promise.all(inputs.map(async function (input) {
              if (input.account !== account) throw new Error('unknown account');
              var sig = await window.__acSolSign(toB64(input.message));
              return { signedMessage: input.message, signature: fromB64(sig) };
            }));
          },
        },
      },
    };
    // the wallet side of the Wallet Standard handshake (@wallet-standard/wallet registerWallet)
    var callback = function (api) { api.register(wallet); };
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
    window.addEventListener('wallet-standard:app-ready', function (e) { callback(e.detail); });
  }
}`;
