/** M3: token balances for tiers (EVM balanceOf, Solana token accounts) and the EIP-1271 smart-wallet check. */
import { describe, expect, it } from 'vitest';
import { createEvm, encodeIsValidSignature, ERC1271_MAGIC, ERC1271_MAGIC_WORD } from '../src/adapters/evm';
import { createSolana, SOL_READ_METHODS, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/adapters/solana';
import { walletTokenBalance } from '../src/index';
import { toUnits } from '../src/util';
import type { HttpRequest } from '../src/types';
import { encUint, fakeHttp, rpcHandler, testEnv, word } from './helpers';

const TOKEN = '0x4200000000000000000000000000000000000abc';
const OWNER = '0x9999999999999999999999999999999999999999';
const BALANCE_OF = '0x70a08231' + word(OWNER.toLowerCase());
const DECIMALS = '0x313ce567';

function erc20(host: string, opts: { balance?: bigint; decimals?: number | null; revertBalance?: boolean }) {
  return rpcHandler(host, {
    eth_call: p => {
      const { to, data } = p[0] as { to: string; data: string };
      if (to.toLowerCase() !== TOKEN) return '0x';
      if (data.startsWith('0x70a08231')) {
        if (opts.revertBalance) return { error: { code: 3, message: 'execution reverted' } };
        return encUint(data === BALANCE_OF ? opts.balance ?? 0n : 0n);
      }
      if (data === DECIMALS) return opts.decimals == null ? { error: { code: 3, message: 'execution reverted' } } : encUint(opts.decimals);
      return { error: { code: 3, message: 'execution reverted' } };
    },
  });
}

describe('toUnits', () => {
  it('keeps the integer part exact and adds the fraction', () => {
    expect(toUnits(1234567890000000000000n, 18)).toBe(1234.56789);
    expect(toUnits(2_500_000_000_000_000n, 9)).toBe(2_500_000);
    expect(toUnits(1n, 6)).toBe(0.000001);
    expect(toUnits(42n, 0)).toBe(42);
  });
});

describe('EVM adapter: tokenBalance', () => {
  it('balanceOf(owner) / 10^decimals() over eth_call on the given chain', async () => {
    const http = fakeHttp(erc20('mainnet.base.org', { balance: 3_100_000n * 10n ** 18n + 5n * 10n ** 17n, decimals: 18 }));
    const evm = createEvm(testEnv(), http);
    expect(await evm.tokenBalance('base', TOKEN, OWNER)).toBe(3_100_000.5);
    const bodies = http.calls.map(c => c.body as { method: string; params: [{ to: string; data: string }, string] });
    expect(bodies.every(b => b.method === 'eth_call' && b.params[1] === 'latest')).toBe(true);
    expect(bodies.map(b => b.params[0].data).sort()).toEqual([BALANCE_OF, DECIMALS].sort());
    expect(http.calls.every(c => c.url === 'https://mainnet.base.org')).toBe(true);
  });

  it('caches decimals(): a second read only calls balanceOf', async () => {
    const http = fakeHttp(erc20('mainnet.base.org', { balance: 7n * 10n ** 6n, decimals: 6 }));
    const evm = createEvm(testEnv(), http);
    expect(await evm.tokenBalance('base', TOKEN, OWNER)).toBe(7);
    const before = http.calls.length;
    expect(await evm.tokenBalance('base', TOKEN, OWNER.replace('0x9', '0x8'))).toBe(0);
    expect(http.calls.length - before).toBe(1);
  });

  it('a zero balance is 0, not null', async () => {
    const evm = createEvm(testEnv(), fakeHttp(erc20('mainnet.base.org', { balance: 0n, decimals: 18 })));
    expect(await evm.tokenBalance('base', TOKEN, OWNER)).toBe(0);
  });

  it('no ERC-20 at the address (balanceOf reverts / no decimals) → null with lastError, never a guessed scale', async () => {
    const reverts = createEvm(testEnv(), fakeHttp(erc20('mainnet.base.org', { revertBalance: true, decimals: 18 })));
    expect(await reverts.tokenBalance('base', TOKEN, OWNER)).toBeNull();
    expect(reverts.lastError).toBe('evm.tokenBalance base: balanceOf() unreadable at the token address');

    const noDecimals = createEvm(testEnv(), fakeHttp(erc20('mainnet.base.org', { balance: 10n, decimals: null })));
    expect(await noDecimals.tokenBalance('base', TOKEN, OWNER)).toBeNull();
    expect(noDecimals.lastError).toBe('evm.tokenBalance base: decimals() unreadable at the token address');
  });

  it('transport errors → null; bad addresses and chains without an EVM RPC → null without a request', async () => {
    const down = fakeHttp(() => ({ status: 502, text: 'bad gateway' }));
    const evm = createEvm(testEnv(), down);
    expect(await evm.tokenBalance('eth', TOKEN, OWNER)).toBeNull();
    expect(evm.lastError).toMatch(/^evm\.tokenBalance eth: HTTP 502/);

    const none = fakeHttp();
    const evm2 = createEvm(testEnv(), none);
    expect(await evm2.tokenBalance('base', 'not-an-address', OWNER)).toBeNull();
    expect(await evm2.tokenBalance('base', TOKEN, '0x123')).toBeNull();
    expect(await evm2.tokenBalance('trx', TOKEN, OWNER)).toBeNull();
    expect(none.calls).toHaveLength(0);
  });
});

describe('EVM adapter: isValidSignature (EIP-1271)', () => {
  const WALLET = '0x5555555555555555555555555555555555555555';
  const HASH = '0x' + 'ab'.repeat(32);
  const SIG = '0x' + '11'.repeat(65);

  it('encodes isValidSignature(bytes32,bytes) per the ABI', () => {
    const data = encodeIsValidSignature(HASH, '0x' + 'cd'.repeat(3));
    expect(data).toBe(ERC1271_MAGIC + 'ab'.repeat(32) + word('40') + word('3') + 'cdcdcd'.padEnd(64, '0'));
    // a 65-byte signature takes three words
    expect(encodeIsValidSignature(HASH, SIG).length).toBe(10 + 64 * 3 + 64 * 3);
  });

  it('true only for the magic value; another value or a revert → false', async () => {
    let answer: unknown = ERC1271_MAGIC + '0'.repeat(56);
    const http = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: () => answer }));
    const evm = createEvm(testEnv(), http);
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(true);
    const sent = http.calls[0].body as { params: [{ to: string; data: string }] };
    expect(sent.params[0]).toEqual({ to: WALLET, data: encodeIsValidSignature(HASH, SIG) });
    expect(http.calls[0].req.timeoutMs).toBe(4000);

    answer = '0xffffffff' + '0'.repeat(56);
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    answer = { error: { code: 3, message: 'execution reverted' } };
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    // an externally owned account: eth_call returns empty data
    answer = '0x';
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
  });

  it('only the whole ABI word counts: a contract echoing its call data (identity precompile) or a short answer → false', async () => {
    expect(ERC1271_MAGIC_WORD).toBe('0x1626ba7e' + '0'.repeat(56));
    let answer: (data: string) => unknown = data => data;
    const http = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: p => answer((p[0] as { data: string }).data) }));
    const evm = createEvm(testEnv(), http);
    // a fallback that returns msg.data: the call data starts with the selector, which equals the magic value
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    expect(http.calls).toHaveLength(1);
    // only the 4 magic bytes, or the magic word cut short
    answer = () => ERC1271_MAGIC;
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    answer = () => ERC1271_MAGIC + '0'.repeat(54);
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    // magic bytes followed by non-zero bytes in the same word
    answer = () => ERC1271_MAGIC + '0'.repeat(55) + '1';
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(false);
    // the padded word (any case), also with trailing data after it, is valid
    answer = () => ERC1271_MAGIC_WORD.toUpperCase().replace('0X', '0x');
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(true);
    answer = () => ERC1271_MAGIC_WORD + 'ff'.repeat(32);
    expect(await evm.isValidSignature('base', WALLET, HASH, SIG)).toBe(true);
  });

  it('precompiles and reserved low addresses are never wallets: false without a request', async () => {
    const http = fakeHttp(rpcHandler('mainnet.base.org', { eth_call: p => (p[0] as { data: string }).data }));
    const evm = createEvm(testEnv(), http);
    for (const a of ['0x0000000000000000000000000000000000000004', '0x0000000000000000000000000000000000000100', '0x000000000000000000000000000000000000ffff']) {
      expect(await evm.isValidSignature('base', a, HASH, SIG)).toBe(false);
    }
    expect(http.calls).toHaveLength(0);
    // the first address past the range is asked
    expect(await evm.isValidSignature('base', '0x0000000000000000000000000000000000010000', HASH, SIG)).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('a chain that does not answer → null (unknown), with lastError; malformed input → null without a request', async () => {
    const http = fakeHttp(() => ({ status: 503, text: 'unavailable' }));
    const evm = createEvm(testEnv(), http);
    expect(await evm.isValidSignature('eth', WALLET, HASH, SIG, { timeoutMs: 1500 })).toBeNull();
    expect(http.calls[0].req.timeoutMs).toBe(1500);
    expect(evm.lastError).toMatch(/^evm\.isValidSignature eth: /);
    const n = http.calls.length;
    expect(await evm.isValidSignature('eth', WALLET, '0x1234', SIG)).toBeNull();
    expect(await evm.isValidSignature('eth', WALLET, HASH, 'zz')).toBeNull();
    expect(await evm.isValidSignature('eth', 'nope', HASH, SIG)).toBeNull();
    expect(http.calls.length).toBe(n);
  });
});

describe('Solana adapter: tokenBalance', () => {
  const HOST = 'api.mainnet-beta.solana.com';
  const MINT = 'APEcheckMint1111111111111111111111111111111';
  const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const WALLET = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
  const acct = (program: string, mint: string, amount: string, decimals = 6) => ({
    pubkey: 'Acc' + Math.random().toString(36).slice(2, 12).padEnd(40, '1'),
    account: {
      owner: program,
      lamports: 2039280,
      executable: false,
      rentEpoch: 18446744073709551615,
      space: program === SPL_TOKEN_PROGRAM ? 165 : 182,
      data: {
        program: program === SPL_TOKEN_PROGRAM ? 'spl-token' : 'spl-token-2022',
        parsed: {
          type: 'account',
          info: {
            isNative: false,
            mint,
            owner: WALLET,
            state: 'initialized',
            tokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) },
          },
        },
      },
    },
  });

  /**
   * A fake getTokenAccountsByOwner over the owner's whole wallet: answers a `{ mint }` filter with that mint's
   * accounts only (as the RPC does), and a `{ programId }` scan with every account of that program.
   */
  const wallet = (accounts: ReturnType<typeof acct>[]) =>
    rpcHandler(HOST, {
      getTokenAccountsByOwner: p => {
        const f = p[1] as { mint?: string; programId?: string };
        const value = accounts.filter(a =>
          f.mint ? (a.account.data.parsed.info.mint === f.mint) : a.account.owner === f.programId,
        );
        return { context: { slot: 1 }, value };
      },
    });

  it('one query filtered by the mint (jsonParsed); sums its accounts under either token program', async () => {
    const http = fakeHttp(
      wallet([acct(SPL_TOKEN_PROGRAM, MINT, '250000000000'), acct(SPL_TOKEN_PROGRAM, OTHER, '999000000'), acct(TOKEN_2022_PROGRAM, MINT, '500000')]),
    );
    const sol = createSolana(testEnv(), http);
    expect(await sol.tokenBalance(WALLET, MINT)).toBe(250_000.5);
    expect(http.calls.map(c => c.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'getTokenAccountsByOwner',
        params: [WALLET, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      },
    ]);
    expect(SOL_READ_METHODS.has('getTokenAccountsByOwner')).toBe(true);
  });

  it('spam token accounts of other mints never reach the reply (the owner cannot make their own read fail)', async () => {
    // 20,000 spam accounts: a programId-wide scan answers ~10 MB, past the 8 MB reply cap the real client enforces
    const spam = Array.from({ length: 20_000 }, (_, i) => acct(SPL_TOKEN_PROGRAM, `Spam${String(i).padStart(40, '1')}`, '1', 0));
    const http = fakeHttp(wallet([...spam, acct(SPL_TOKEN_PROGRAM, MINT, '42000000')]));
    const capped: typeof http = {
      ...http,
      async json<T>(url: string, req: HttpRequest = {}) {
        const res = await http.request(url, req);
        if (req.maxBytes != null && Buffer.byteLength(res.text) > req.maxBytes) throw new Error(`response is larger than ${req.maxBytes} bytes`);
        return JSON.parse(res.text) as T;
      },
    };
    const sol = createSolana(testEnv(), capped);
    expect(await sol.tokenBalance(WALLET, MINT)).toBe(42);
    expect(sol.lastError).toBeNull();
    expect(http.calls).toHaveLength(1);
    expect((http.calls[0].body as { params: unknown[] }).params[1]).toEqual({ mint: MINT });
  });

  it('no account of the mint → 0; accounts of another mint or program in the reply are ignored', async () => {
    const http = fakeHttp(wallet([acct(SPL_TOKEN_PROGRAM, OTHER, '5')]));
    expect(await createSolana(testEnv(), http).tokenBalance(WALLET, MINT)).toBe(0);
    // a reply that (wrongly) holds other accounts: only the mint's, under a token program, count
    const odd = acct(SPL_TOKEN_PROGRAM, MINT, '7000000');
    odd.account.owner = '11111111111111111111111111111111';
    const loose = fakeHttp(rpcHandler(HOST, { getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: [acct(SPL_TOKEN_PROGRAM, OTHER, '5000000'), odd, acct(TOKEN_2022_PROGRAM, MINT, '3000000')] }) }));
    expect(await createSolana(testEnv(), loose).tokenBalance(WALLET, MINT)).toBe(3);
  });

  it('the query failing → null (never a guessed 0), with lastError', async () => {
    const http = fakeHttp(rpcHandler(HOST, { getTokenAccountsByOwner: () => ({ error: { code: -32005, message: 'Node is behind' } }) }));
    const sol = createSolana(testEnv(), http);
    expect(await sol.tokenBalance(WALLET, MINT)).toBeNull();
    expect(sol.lastError).toBe('solana.tokenBalance: Node is behind');
  });

  it('malformed addresses → null without a request', async () => {
    const http = fakeHttp();
    const sol = createSolana(testEnv(), http);
    expect(await sol.tokenBalance('0xnope', MINT)).toBeNull();
    expect(await sol.tokenBalance(WALLET, 'bad')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('walletTokenBalance', () => {
  it('dispatches by chain family; Tron has no reader', async () => {
    const seen: string[] = [];
    const src = {
      evm: { tokenBalance: async (chain: string, token: string, owner: string) => (seen.push(`evm ${chain} ${token} ${owner}`), 1) },
      sol: { tokenBalance: async (owner: string, mint: string) => (seen.push(`sol ${owner} ${mint}`), 2) },
    };
    expect(await walletTokenBalance(src, 'sol', 'MINT', 'W')).toBe(2);
    expect(await walletTokenBalance(src, 'base', '0xT', '0xW')).toBe(1);
    expect(await walletTokenBalance(src, 'trx', 'T', 'W')).toBeNull();
    expect(seen).toEqual(['sol W MINT', 'evm base 0xT 0xW']);
  });
});
