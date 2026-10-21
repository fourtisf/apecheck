import { describe, expect, it } from 'vitest';
import { createSolana, PUBLIC_SOLANA_RPC, SOL_READ_METHODS, solanaRpcUrl } from '../src/adapters/solana';
import { jsonRpc } from '../src/rpc';
import { fakeHttp, fixture, rpcHandler, testEnv } from './helpers';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const HOST = 'api.mainnet-beta.solana.com';
const ACCOUNTS = ['MASi45ub7Qe4ZE36UT5G6cU4ud8Fhhe4deS4F3cw9KTA', 'b8dLcukC7edhDQ7cn5d4gEYkbUrMWeWQLGsCmrG6dLaY', 'yNoVKf58ZTBqNAYT3j5qcdsyuMNmPfYetW5v6JXmj54o'];
const OWNERS = ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'nTPkyRFA6CAFjF1YveCHK1ATbQgdM9mwZgikp4Wzxrxk'];

describe('Solana adapter: RPC URL', () => {
  it('RPC_SOLANA, else Helius with HELIUS_API_KEY, else the public endpoint', () => {
    expect(solanaRpcUrl(testEnv({ RPC_SOLANA: 'https://my.rpc/x', HELIUS_API_KEY: 'k' }))).toBe('https://my.rpc/x');
    expect(solanaRpcUrl(testEnv({ HELIUS_API_KEY: 'abc 123' }))).toBe('https://mainnet.helius-rpc.com/?api-key=abc%20123');
    expect(solanaRpcUrl(testEnv())).toBe(PUBLIC_SOLANA_RPC);
    expect(PUBLIC_SOLANA_RPC).toBe('https://api.mainnet-beta.solana.com');
  });
});

describe('Solana adapter: mintInfo', () => {
  it('SPL mint: authorities, decimals, supply (getAccountInfo jsonParsed)', async () => {
    const http = fakeHttp(rpcHandler(HOST, { getAccountInfo: () => fixture('solana-mint-spl.json') }));
    expect(await createSolana(testEnv(), http).mintInfo(MINT)).toEqual({
      exists: true, decimals: 6, supply: '999987654321000', mintAuthority: null,
      freezeAuthority: '8SVM5jGU5EjLs8zrAnijQAHy9WFp7SyYBjvFBnUZSNTD', token2022: false,
    });
    expect(http.calls[0].body).toMatchObject({ method: 'getAccountInfo', params: [MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }] });
  });

  it('Token-2022 mint', async () => {
    const http = fakeHttp(rpcHandler(HOST, { getAccountInfo: () => fixture('solana-mint-2022.json') }));
    expect(await createSolana(testEnv(), http).mintInfo(MINT)).toMatchObject({
      exists: true, decimals: 9, mintAuthority: 'PM6oQ2NcWVn2RNagKZ58sFy76HJ3zrCJq9uUwkuHSAbZ', freezeAuthority: null, token2022: true,
    });
  });

  it('Token-2022 extensions: the settings an authority changes, never the counters that move on their own', async () => {
    const base = fixture<{ value: { data: { parsed: { info: Record<string, unknown> } } } }>('solana-mint-2022.json');
    const withExt = (transferFee: { bps: number; withheld: string }, hook: string) => {
      const doc = JSON.parse(JSON.stringify(base)) as typeof base;
      doc.value.data.parsed.info.extensions = [
        { extension: 'transferHook', state: { authority: 'H00kAuth1111111111111111111111111111111111', programId: hook } },
        {
          extension: 'transferFeeConfig',
          state: {
            transferFeeConfigAuthority: 'FeeAuth111111111111111111111111111111111111', withdrawWithheldAuthority: null,
            withheldAmount: transferFee.withheld, olderTransferFee: { epoch: 600, maximumFee: 0, transferFeeBasisPoints: 0 },
            newerTransferFee: { epoch: 700, maximumFee: 5000, transferFeeBasisPoints: transferFee.bps },
          },
        },
        { extension: 'nonTransferable' },
        { extension: 'metadataPointer', state: { authority: null, metadataAddress: MINT } },
      ];
      return doc;
    };
    const info = async (doc: unknown) => (await createSolana(testEnv(), fakeHttp(rpcHandler(HOST, { getAccountInfo: () => doc }))).mintInfo(MINT))!;
    const a = await info(withExt({ bps: 100, withheld: '10' }, 'Hook111111111111111111111111111111111111111'));
    expect(a.extensions).toEqual([
      `metadataPointer authority=none metadataAddress=${MINT}`,
      'nonTransferable',
      'transferFeeConfig transferFeeConfigAuthority=FeeAuth111111111111111111111111111111111111 withdrawWithheldAuthority=none newerTransferFee.transferFeeBasisPoints=100 newerTransferFee.maximumFee=5000',
      'transferHook authority=H00kAuth1111111111111111111111111111111111 programId=Hook111111111111111111111111111111111111111',
    ]);
    // withheld fees grow with every transfer: not a setting
    expect((await info(withExt({ bps: 100, withheld: '99999' }, 'Hook111111111111111111111111111111111111111'))).extensions).toEqual(a.extensions);
    expect((await info(withExt({ bps: 9900, withheld: '10' }, 'Hook111111111111111111111111111111111111111'))).extensions).not.toEqual(a.extensions);
    expect((await info(withExt({ bps: 100, withheld: '10' }, 'Hook222222222222222222222222222222222222222'))).extensions).not.toEqual(a.extensions);
  });

  it('missing account or a non-mint account → exists:false', async () => {
    const none = fakeHttp(rpcHandler(HOST, { getAccountInfo: () => ({ context: { slot: 1 }, value: null }) }));
    expect(await createSolana(testEnv(), none).mintInfo(MINT)).toMatchObject({ exists: false, mintAuthority: null });
    const wallet = fakeHttp(rpcHandler(HOST, { getAccountInfo: () => ({ context: { slot: 1 }, value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } }) }));
    expect((await createSolana(testEnv(), wallet).mintInfo(MINT))?.exists).toBe(false);
  });

  it('RPC error → null with lastError; malformed mint → null without a request', async () => {
    const http = fakeHttp(rpcHandler(HOST, { getAccountInfo: () => ({ error: { code: -32602, message: 'Invalid param: WrongSize' } }) }));
    const sol = createSolana(testEnv(), http);
    expect(await sol.mintInfo(MINT)).toBeNull();
    expect(sol.lastError).toBe('solana.mintInfo: Invalid param: WrongSize');
    expect(await sol.mintInfo('0xnot-solana')).toBeNull();
    expect(http.calls).toHaveLength(1);
  });
});

describe('Solana adapter: largestHolders', () => {
  it('getTokenLargestAccounts + getTokenSupply + getMultipleAccounts owners → pct of supply', async () => {
    const http = fakeHttp(
      rpcHandler(HOST, {
        getTokenLargestAccounts: () => ({
          context: { slot: 1 },
          value: [
            { address: ACCOUNTS[0], amount: '250000000000000', decimals: 6, uiAmount: 250000000, uiAmountString: '250000000' },
            { address: ACCOUNTS[1], amount: '50000000000000', decimals: 6, uiAmount: 50000000, uiAmountString: '50000000' },
            { address: ACCOUNTS[2], amount: '1234567', decimals: 6, uiAmount: 1.234567, uiAmountString: '1.234567' },
          ],
        }),
        getTokenSupply: () => ({ context: { slot: 1 }, value: { amount: '1000000000000000', decimals: 6, uiAmountString: '1000000000' } }),
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [
            { data: { parsed: { info: { owner: OWNERS[0], mint: MINT }, type: 'account' }, program: 'spl-token' }, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { data: { parsed: { info: { owner: OWNERS[1], mint: MINT }, type: 'account' }, program: 'spl-token' }, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            null,
          ],
        }),
      }),
    );
    const rows = await createSolana(testEnv(), http).largestHolders(MINT);
    expect(rows).toEqual([
      { owner: OWNERS[0], account: ACCOUNTS[0], amount: '250000000000000', pct: 25 },
      { owner: OWNERS[1], account: ACCOUNTS[1], amount: '50000000000000', pct: 5 },
      { owner: null, account: ACCOUNTS[2], amount: '1234567', pct: 0 },
    ]);
    const multi = http.calls.find(c => (c.body as { method: string }).method === 'getMultipleAccounts');
    expect((multi?.body as { params: unknown[] }).params).toEqual([ACCOUNTS, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  });

  it('owner lookup failing keeps the balances; largest-accounts failing → []', async () => {
    const partial = fakeHttp(
      rpcHandler(HOST, {
        getTokenLargestAccounts: () => ({ value: [{ address: ACCOUNTS[0], amount: '10' }] }),
        getTokenSupply: () => ({ value: { amount: '100' } }),
        getMultipleAccounts: () => ({ error: { code: 429, message: 'Too many requests' } }),
      }),
    );
    const sol = createSolana(testEnv(), partial);
    expect(await sol.largestHolders(MINT)).toEqual([{ owner: null, account: ACCOUNTS[0], amount: '10', pct: 10 }]);
    expect(sol.lastError).toMatch(/largestHolders owners: Too many requests/);
    const failing = fakeHttp(rpcHandler(HOST, { getTokenLargestAccounts: () => ({ error: { code: -32010, message: 'excluded from account secondary indexes' } }), getTokenSupply: () => ({ value: { amount: '1' } }) }));
    expect(await createSolana(testEnv(), failing).largestHolders(MINT)).toEqual([]);
    // not a busy node: asked once, no retry
    expect(failing.calls.filter(c => (c.body as { method: string }).method === 'getTokenLargestAccounts')).toHaveLength(1);
  });

  it('a busy node ("overloaded, please try again"): once more, then the public node; the owners stay on the configured RPC', async () => {
    const HELIUS = 'mainnet.helius-rpc.com';
    const busy = () => ({ error: { code: -32603, message: 'account index service overloaded, please try again.' } });
    const answer = () => ({ value: [{ address: ACCOUNTS[0], amount: '10' }] });
    const node = (largest: () => unknown) =>
      rpcHandler(HELIUS, {
        getTokenLargestAccounts: largest,
        getTokenSupply: () => ({ value: { amount: '100' } }),
        getMultipleAccounts: () => ({ value: [{ data: { parsed: { info: { owner: OWNERS[0], mint: MINT }, type: 'account' }, program: 'spl-token' }, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }] }),
      });
    const largestHosts = (h: ReturnType<typeof fakeHttp>) =>
      h.calls.filter(c => (c.body as { method: string }).method === 'getTokenLargestAccounts').map(c => new URL(c.url).host);

    let n = 0;
    const second = fakeHttp(node(() => (n++ === 0 ? busy() : answer())));
    expect(await createSolana(testEnv({ HELIUS_API_KEY: 'k' }), second).largestHolders(MINT)).toEqual([{ owner: OWNERS[0], account: ACCOUNTS[0], amount: '10', pct: 10 }]);
    expect(largestHosts(second)).toEqual([HELIUS, HELIUS]);

    const fallback = fakeHttp(node(busy), rpcHandler(HOST, { getTokenLargestAccounts: answer }));
    expect(await createSolana(testEnv({ HELIUS_API_KEY: 'k' }), fallback).largestHolders(MINT)).toEqual([{ owner: OWNERS[0], account: ACCOUNTS[0], amount: '10', pct: 10 }]);
    expect(largestHosts(fallback)).toEqual([HELIUS, HELIUS, HOST]);
    const owners = fallback.calls.find(c => (c.body as { method: string }).method === 'getMultipleAccounts');
    expect(new URL(owners!.url).host).toBe(HELIUS);

    // already on the public node: no third request
    const pub = fakeHttp(rpcHandler(HOST, { getTokenLargestAccounts: busy, getTokenSupply: () => ({ value: { amount: '1' } }) }));
    const sol = createSolana(testEnv(), pub);
    expect(await sol.largestHolders(MINT)).toEqual([]);
    expect(largestHosts(pub)).toEqual([HOST, HOST]);
    expect(sol.lastError).toMatch(/largestHolders: account index service overloaded/);
  });
});

describe('Solana adapter: simulate (never send)', () => {
  const TX = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQABAg==';

  it('simulateTransaction with base64, sigVerify:false, replaceRecentBlockhash:true', async () => {
    const http = fakeHttp(rpcHandler(HOST, { simulateTransaction: () => ({ context: { slot: 1 }, value: { err: null, logs: ['Program 111 invoke [1]', 'Program 111 success'], unitsConsumed: 150 } }) }));
    expect(await createSolana(testEnv(), http).simulate(TX)).toEqual({ ok: true, error: null, gas: '150', logs: ['Program 111 invoke [1]', 'Program 111 success'] });
    expect(http.calls[0].body).toMatchObject({
      method: 'simulateTransaction',
      params: [TX, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }],
    });
  });

  it('a failing simulation reports the instruction error and the program log line', async () => {
    const http = fakeHttp(
      rpcHandler(HOST, {
        simulateTransaction: () => ({
          value: {
            err: { InstructionError: [2, { Custom: 6001 }] },
            logs: ['Program JUP invoke [1]', 'Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.', 'Program JUP failed: custom program error: 0x1771'],
            unitsConsumed: 41234,
          },
        }),
      }),
    );
    const r = await createSolana(testEnv(), http).simulate(TX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^instruction 2 failed: \{"Custom":6001\} \(Program JUP failed: custom program error: 0x1771\)$/);
    expect(r.gas).toBe('41234');
  });

  it('RPC down → ok:false "simulation unavailable"; not base64 → refused without a request', async () => {
    const sol = createSolana(testEnv(), fakeHttp(() => ({ status: 503, text: 'unavailable' })));
    expect(await sol.simulate(TX)).toMatchObject({ ok: false, error: expect.stringMatching(/^simulation unavailable: HTTP 503/) });
    const http = fakeHttp();
    expect(await createSolana(testEnv(), http).simulate('not base64!')).toMatchObject({ ok: false, error: 'not a base64 transaction' });
    expect(http.calls).toHaveLength(0);
  });

  it('never builds sendTransaction', async () => {
    const http = fakeHttp(
      rpcHandler(HOST, {
        getAccountInfo: () => fixture('solana-mint-spl.json'),
        getTokenLargestAccounts: () => ({ value: [] }),
        getTokenSupply: () => ({ value: { amount: '1' } }),
        simulateTransaction: () => ({ value: { err: null, logs: [] } }),
      }),
    );
    const sol = createSolana(testEnv(), http);
    await sol.mintInfo(MINT);
    await sol.largestHolders(MINT);
    await sol.simulate(TX);
    expect(http.calls.length).toBeGreaterThanOrEqual(4);
    expect(http.calls.some(c => /sendTransaction|sendRawTransaction|requestAirdrop/i.test(JSON.stringify(c.body)))).toBe(false);
    for (const m of SOL_READ_METHODS) expect(m).not.toMatch(/send|airdrop/i);
    await expect(jsonRpc(http, `https://${HOST}`, 'sendTransaction', [TX], SOL_READ_METHODS)).rejects.toThrow(/not allowed/);
    expect(http.calls.some(c => JSON.stringify(c.body).includes('"sendTransaction"'))).toBe(false);
  });
});
