/** Sign-in messages (EIP-4361 / SIWS) and signature checks, with keys generated in the test. */
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { base58Encode } from '@apecheck/sources';
import {
  MessageError,
  SIGN_IN_STATEMENT,
  appIdentity,
  buildSignInMessage,
  parseSignInMessage,
  toChecksumAddress,
  validateSignInFields,
  type SignInFields,
} from '../src/auth/message';
import { contractWalletChain, personalSignHash, recoverPersonalSign, verifyEvmSignature } from '../src/auth/evm';
import { signatureCandidates, solanaPublicKey, verifySolanaSignature } from '../src/auth/solana';
import { EvmWallet, FakeSources, SolWallet } from './helpers';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 10 * 60_000);
const { domain, uri } = appIdentity('https://apecheck.io/');

const evmMessage = (address: string, over: Partial<Parameters<typeof buildSignInMessage>[0]> = {}) =>
  buildSignInMessage({ chain: 'evm', domain, uri, address, chainId: 8453, nonce: 'abcDEF123456', issuedAt: NOW, expirationTime: LATER, ...over });
const solMessage = (address: string) =>
  buildSignInMessage({ chain: 'sol', domain, uri, address, nonce: 'abcDEF123456', issuedAt: NOW, expirationTime: LATER });

describe('EIP-4361 message', () => {
  it('builds the exact EIP-4361 text with the EIP-55 address', () => {
    // EIP-55 test vectors
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(toChecksumAddress('0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359')).toBe('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
    expect(evmMessage('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      [
        'apecheck.io wants you to sign in with your Ethereum account:',
        '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        '',
        "Sign in to ApeCheck. This doesn't send a transaction or cost anything.",
        '',
        'URI: https://apecheck.io',
        'Version: 1',
        'Chain ID: 8453',
        'Nonce: abcDEF123456',
        'Issued At: 2026-10-19T12:00:00.000Z',
        'Expiration Time: 2026-10-19T12:10:00.000Z',
      ].join('\n'),
    );
    expect(appIdentity('http://localhost:3000')).toEqual({ domain: 'localhost:3000', uri: 'http://localhost:3000' });
  });

  it('parses what it builds', () => {
    const f = parseSignInMessage('evm', evmMessage('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'));
    expect(f).toEqual({
      chain: 'evm', domain, address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', statement: SIGN_IN_STATEMENT, uri, version: '1', chainId: 8453,
      nonce: 'abcDEF123456', issuedAt: NOW.toISOString(), expirationTime: LATER.toISOString(), notBefore: null, requestId: null, resources: [],
    });
  });

  it('parses the optional EIP-4361 fields and a message without a statement', () => {
    const text = [
      'example.com wants you to sign in with your Ethereum account:',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '',
      '',
      'URI: https://example.com/login',
      'Version: 1',
      'Chain ID: 1',
      'Nonce: 32891756aaaa',
      'Issued At: 2021-09-30T16:25:24Z',
      'Expiration Time: 2021-09-30T16:35:24+00:00',
      'Not Before: 2021-09-30T16:25:24Z',
      'Request ID: req-1',
      'Resources:',
      '- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/',
      '- https://example.com/my-web2-claim.json',
    ].join('\n');
    expect(parseSignInMessage('evm', text)).toMatchObject({ statement: null, chainId: 1, requestId: 'req-1', resources: expect.any(Array) });
  });

  it('refuses anything off the layout', () => {
    const good = evmMessage('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
    const bad = [
      good + '\n',
      good.replace(/\n/g, '\r\n'),
      good.replace('Ethereum account', 'Solana account'),
      good.replace('Version: 1\n', ''),
      good.replace('Chain ID: 8453\n', ''),
      good.replace('Chain ID: 8453', 'Chain ID: 0x2105'),
      good.replace('Nonce: abcDEF123456', 'Nonce: short'),
      good.replace('Nonce: abcDEF123456', 'Nonce: abc-DEF-123456'),
      good.replace('Issued At: 2026-10-19T12:00:00.000Z', 'Issued At: yesterday'),
      good + '\nNonce: again12345678',
      good.replace('URI: https://apecheck.io', 'URI: https://apecheck.io extra'),
      good.replace('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'),
      good.replace('\n\nURI', '\nURI'),
      '',
    ];
    for (const m of bad) expect(() => parseSignInMessage('evm', m), JSON.stringify(m)).toThrow(MessageError);
  });
});

describe('Sign-In With Solana message', () => {
  it('has the Solana layout without a Chain ID and parses back', () => {
    const w = new SolWallet();
    const m = solMessage(w.address);
    expect(m).toBe(
      `apecheck.io wants you to sign in with your Solana account:\n${w.address}\n\n${SIGN_IN_STATEMENT}\n\nURI: https://apecheck.io\nVersion: 1\nNonce: abcDEF123456\nIssued At: 2026-10-19T12:00:00.000Z\nExpiration Time: 2026-10-19T12:10:00.000Z`,
    );
    expect(parseSignInMessage('sol', m)).toMatchObject({ chain: 'sol', address: w.address, chainId: null });
    expect(() => parseSignInMessage('evm', m)).toThrow(MessageError);
    expect(() => parseSignInMessage('sol', m.replace(w.address, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'))).toThrow(MessageError);
  });
});

describe('validateSignInFields', () => {
  const addr = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
  const f = (): SignInFields => parseSignInMessage('evm', evmMessage(addr));
  const exp = { chain: 'evm' as const, domain, uri, address: addr.toUpperCase().replace('0X', '0x'), nonce: 'abcDEF123456', now: new Date(NOW.getTime() + 60_000) };
  const reason = (fields: SignInFields, e = exp) => {
    try {
      validateSignInFields(fields, e);
      return 'ok';
    } catch (err) {
      return (err as MessageError).reason;
    }
  };

  it('accepts a fresh message for this site (address compared case-insensitively)', () => {
    expect(reason(f())).toBe('ok');
  });

  it('names the rule a message breaks', () => {
    expect(reason({ ...f(), domain: 'evil.example' })).toBe('domain');
    expect(reason({ ...f(), uri: 'https://evil.example' })).toBe('uri');
    expect(reason({ ...f(), version: '2' })).toBe('version');
    expect(reason({ ...f(), nonce: 'otherNonce123' })).toBe('nonce');
    expect(reason({ ...f(), address: '0x0000000000000000000000000000000000000001' })).toBe('address');
    expect(reason({ ...f(), chainId: null })).toBe('chain id');
    expect(reason(f(), { ...exp, now: new Date(NOW.getTime() - 5 * 60_000) })).toBe('issued in the future');
    expect(reason(f(), { ...exp, now: new Date(LATER.getTime() + 1) })).toBe('expired');
    expect(reason({ ...f(), expirationTime: null })).toBe('no expiration time');
    expect(reason({ ...f(), expirationTime: new Date(NOW.getTime() + 3600_000).toISOString() })).toBe('expiration too far out');
    expect(reason({ ...f(), notBefore: new Date(NOW.getTime() + 5 * 60_000).toISOString() })).toBe('not valid yet');
  });
});

describe('EVM signatures', () => {
  it('recovers the signer of a personal_sign signature (v 27/28 and 0/1)', () => {
    const w = new EvmWallet();
    const m = evmMessage(w.address);
    expect(recoverPersonalSign(m, w.sign(m))).toBe(w.address);
    expect(recoverPersonalSign(m, w.sign(m, { v01: true }))).toBe(w.address);
  });

  it('hashes like personal_sign: the byte length (not the character count) goes in the prefix', () => {
    const msg = 'gm ✓';
    const expected = keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n6'), Buffer.from(msg, 'utf8')]));
    expect(Buffer.from(personalSignHash(msg)).equals(Buffer.from(expected))).toBe(true);
  });

  it('matches a known signer: the private key 0x…01 is 0x7e5f…5bdf', () => {
    const one = new Uint8Array(32);
    one[31] = 1;
    expect(new EvmWallet(one).address).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  });

  it('refuses high-s, bad v, wrong lengths and junk', () => {
    const w = new EvmWallet();
    const m = evmMessage(w.address);
    const sig = secp256k1.sign(personalSignHash(m), w.priv);
    // the same signature with s' = n - s and the other recovery id is valid math but malleable: refused
    const highS = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
    const hex = '0x' + Buffer.from(highS.toCompactRawBytes()).toString('hex') + (27 + (sig.recovery ^ 1)).toString(16);
    expect(recoverPersonalSign(m, hex)).toBeNull();
    const good = w.sign(m);
    expect(recoverPersonalSign(m, good.slice(0, -2) + '1d')).toBeNull(); // v = 29
    expect(recoverPersonalSign(m, good.slice(0, -2))).toBeNull(); // 64 bytes
    expect(recoverPersonalSign(m, good + '00')).toBeNull();
    expect(recoverPersonalSign(m, 'not hex')).toBeNull();
    expect(recoverPersonalSign(m, '0x' + '00'.repeat(65))).toBeNull(); // r = s = 0
    // a different message recovers someone else
    expect(recoverPersonalSign(m + ' ', good)).not.toBe(w.address);
  });

  it('a smart wallet is checked by EIP-1271 on the one server-chosen chain its message names, never another', async () => {
    const owner = new EvmWallet();
    const safe = '0x5555555555555555555555555555555555555555';
    const m = evmMessage(safe); // Chain ID 8453
    const sig = owner.sign(m);
    const src = new FakeSources();
    const base = { chain: 'base' as const, chainId: 8453 };
    const onBase = { signedChainId: 8453, contract: base };
    expect(await verifyEvmSignature(src, safe, m, sig, onBase)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(src.erc1271Calls.map(c => c.chain)).toEqual(['base']);
    expect(src.erc1271Calls[0]).toMatchObject({ address: safe, hash: '0x' + Buffer.from(personalSignHash(m)).toString('hex'), signature: sig });

    // whoever controls the address on another chain (rotated owners, a replayed factory, a fresh deploy) gets nothing
    src.erc1271Calls = [];
    src.erc1271.set(`eth:${safe}`, true);
    expect(await verifyEvmSignature(src, safe, m, sig, onBase)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(src.erc1271Calls.map(c => c.chain)).toEqual(['base']);

    // the chain's RPC is down: a retryable answer, and still no other chain
    src.erc1271Calls = [];
    src.erc1271.set(`base:${safe}`, null);
    expect(await verifyEvmSignature(src, safe, m, sig, onBase)).toEqual({ ok: false, reason: 'unavailable', chain: 'base' });
    expect(src.erc1271Calls.map(c => c.chain)).toEqual(['base']);

    src.erc1271.set(`base:${safe}`, true);
    expect(await verifyEvmSignature(src, safe, m, sig, onBase)).toEqual({ ok: true, via: 'erc1271', chain: 'base' });

    // the signed Chain ID must be that chain (EIP-4361: contract accounts resolve on it): the client can't pick another
    src.erc1271Calls = [];
    const mEth = evmMessage(safe, { chainId: 1 });
    expect(await verifyEvmSignature(src, safe, mEth, owner.sign(mEth), { signedChainId: 1, contract: base })).toEqual({ ok: false, reason: 'wrong_chain', chain: 'base' });
    expect(await verifyEvmSignature(src, safe, mEth, owner.sign(mEth), { signedChainId: 1, contract: { chain: 'eth', chainId: 1 } })).toEqual({ ok: true, via: 'erc1271', chain: 'eth' });
    expect(src.erc1271Calls.map(c => c.chain)).toEqual(['eth']);
    // no smart-wallet chain (TOKEN_CHAIN is an EVM chain without a known id): no RPC at all
    src.erc1271Calls = [];
    expect(await verifyEvmSignature(src, safe, m, sig, { signedChainId: 8453, contract: null })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(src.erc1271Calls).toHaveLength(0);

    // an EOA that signed never needs the RPC, whatever chain its wallet is on
    const eoaMsg = evmMessage(owner.address, { chainId: 56 });
    expect(await verifyEvmSignature(src, owner.address, eoaMsg, owner.sign(eoaMsg), { signedChainId: 56, contract: base })).toEqual({ ok: true, via: 'ecrecover' });
    expect(src.erc1271Calls).toHaveLength(0);
    // not hex: no RPC either
    expect(await verifyEvmSignature(src, safe, m, 'zz', onBase)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(src.erc1271Calls).toHaveLength(0);
  });

  it('the smart-wallet chain is TOKEN_CHAIN when it is an EVM chain, else Base', () => {
    expect(contractWalletChain({ TOKEN_CHAIN: 'sol' })).toEqual({ chain: 'base', chainId: 8453 });
    expect(contractWalletChain({ TOKEN_CHAIN: 'trx' })).toEqual({ chain: 'base', chainId: 8453 });
    expect(contractWalletChain({ TOKEN_CHAIN: 'nonsense' })).toEqual({ chain: 'base', chainId: 8453 });
    expect(contractWalletChain({ TOKEN_CHAIN: 'eth' })).toEqual({ chain: 'eth', chainId: 1 });
    expect(contractWalletChain({ TOKEN_CHAIN: ' BASE ' })).toEqual({ chain: 'base', chainId: 8453 });
    expect(contractWalletChain({ TOKEN_CHAIN: 'arb' })).toEqual({ chain: 'arb', chainId: 42161 });
    // an EVM token chain without a known chain id: smart wallets can't sign in (never a fallback to another chain)
    expect(contractWalletChain({ TOKEN_CHAIN: 'rh' })).toBeNull();
  });
});

describe('Solana signatures', () => {
  it('verifies ed25519 over the message, signature in base58 or base64', () => {
    const w = new SolWallet();
    const m = solMessage(w.address);
    expect(verifySolanaSignature(w.address, m, w.sign(m, 'base58'))).toBe(true);
    expect(verifySolanaSignature(w.address, m, w.sign(m, 'base64'))).toBe(true);
  });

  it('refuses another key, a tampered message and malformed signatures', () => {
    const w = new SolWallet();
    const other = new SolWallet();
    const m = solMessage(w.address);
    const sig = w.sign(m);
    expect(verifySolanaSignature(other.address, m, sig)).toBe(false);
    expect(verifySolanaSignature(w.address, m.replace('Version: 1', 'Version: 2'), sig)).toBe(false);
    expect(verifySolanaSignature(w.address, m, other.sign(m))).toBe(false);
    expect(verifySolanaSignature(w.address, m, '')).toBe(false);
    expect(verifySolanaSignature(w.address, m, base58Encode(Buffer.alloc(63, 1)))).toBe(false);
    expect(verifySolanaSignature(w.address, m, Buffer.alloc(64).toString('base64'))).toBe(false);
    expect(verifySolanaSignature(w.address, m, 'not a signature!')).toBe(false);
    expect(verifySolanaSignature('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', m, sig)).toBe(false);
  });

  it('reads the public key from the base58 address; candidates are only 64-byte readings', () => {
    expect(solanaPublicKey(new SolWallet().address)).not.toBeNull();
    expect(solanaPublicKey('1111')).toBeNull();
    expect(signatureCandidates(base58Encode(Buffer.alloc(64, 7)))).toHaveLength(1);
    expect(signatureCandidates(Buffer.alloc(64, 7).toString('base64'))).toHaveLength(1);
    expect(signatureCandidates(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(0);
  });
});
