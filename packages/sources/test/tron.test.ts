import { describe, expect, it } from 'vitest';
import { createTron, TRON_ZERO_ADDRESS } from '../src/adapters/tron';
import { tronFromHex, tronToHex } from '../src/base58';
import { captureErrors } from '../src/util';
import { encString, encUint, fakeHttp, fixture, testEnv, word, type Handler } from './helpers';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const OWNER_HEX = 'ab'.repeat(20);

function trongrid(constants: Record<string, string | null>, contract: unknown = fixture('tron-getcontract.json')): Handler {
  return (url, _req, body) => {
    if (url.host !== 'api.trongrid.io') return undefined;
    if (url.pathname === '/wallet/getcontract') return { json: contract };
    if (url.pathname === '/wallet/triggerconstantcontract') {
      const sel = (body as { function_selector: string }).function_selector;
      const hex = constants[sel];
      if (hex == null) return { json: { result: { code: 'REVERT', message: '' }, constant_result: [''] } };
      return { json: { result: { result: true }, energy_used: 300, constant_result: [hex.replace(/^0x/, '')] } };
    }
    return undefined;
  };
}

describe('base58check (Tron addresses)', () => {
  it('encodes and decodes known addresses', () => {
    expect(tronFromHex('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(USDT);
    expect(tronFromHex('a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(USDT);
    expect(tronFromHex('41' + '00'.repeat(20))).toBe(TRON_ZERO_ADDRESS);
    expect(tronToHex(USDT)).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBeNull(); // bad checksum
  });
});

describe('Tron adapter', () => {
  it('tokenInfo: getcontract + constant calls → basics, base58 owner, creator, mint scan', async () => {
    const http = fakeHttp(
      trongrid({
        'name()': encString('Kairo TRC20'),
        'symbol()': encString('KTRC'),
        'decimals()': encUint(6),
        'totalSupply()': encUint(1_000_000_000_000_000n),
        'owner()': '0x' + word(OWNER_HEX),
      }),
    );
    const info = await createTron(testEnv({ TRONGRID_API_KEY: 'tg-key' }), http).tokenInfo(USDT);
    expect(info).toEqual({
      name: 'Kairo TRC20',
      symbol: 'KTRC',
      decimals: 6,
      totalSupply: '1000000000000000',
      owner: tronFromHex(OWNER_HEX),
      creator: 'TBckp5W67rgZ8kE5CArzqWgCpBHPqarGht',
      hasMintFunction: true,
      ownerRenounced: false,
    });
    expect(http.calls[0]).toMatchObject({ url: 'https://api.trongrid.io/wallet/getcontract', body: { value: USDT, visible: true } });
    expect(http.calls[0].req.headers?.['TRON-PRO-API-KEY']).toBe('tg-key');
    const nameCall = http.calls.find(c => (c.body as { function_selector?: string }).function_selector === 'name()');
    expect(nameCall?.body).toEqual({ owner_address: USDT, contract_address: USDT, function_selector: 'name()', parameter: '', visible: true });
  });

  it('zero owner counts as renounced; no API key header without TRONGRID_API_KEY', async () => {
    const http = fakeHttp(trongrid({ 'owner()': '0x' + word('00'), 'symbol()': encString('Z') }));
    const info = await createTron(testEnv(), http).tokenInfo(USDT);
    expect(info).toMatchObject({ owner: TRON_ZERO_ADDRESS, ownerRenounced: true, name: 'KairoTRC20', decimals: null });
    expect(http.calls[0].req.headers?.['TRON-PRO-API-KEY']).toBeUndefined();
  });

  it('no owner() and no owner selector in the bytecode → renounced', async () => {
    const contract = { ...fixture<Record<string, unknown>>('tron-getcontract.json'), bytecode: '6080604052636fdde0314' };
    const info = await createTron(testEnv(), fakeHttp(trongrid({}, contract))).tokenInfo(USDT);
    expect(info).toMatchObject({ owner: null, ownerRenounced: true, hasMintFunction: false });
  });

  it('no owner() but a mint function or role-based control (AccessControl) → owner unknown, not renounced', async () => {
    const base = fixture<Record<string, unknown>>('tron-getcontract.json');
    const minter = { ...base, bytecode: '6080604052' + '6340c10f19' + '6391d14854' + '632f2ff15d' + '00' };
    expect(await createTron(testEnv(), fakeHttp(trongrid({}, minter))).tokenInfo(USDT)).toMatchObject({ owner: null, ownerRenounced: null, hasMintFunction: true });
    const roles = { ...base, bytecode: '6080604052' + '6391d14854' + '632f2ff15d' + '00' };
    expect(await createTron(testEnv(), fakeHttp(trongrid({}, roles))).tokenInfo(USDT)).toMatchObject({ owner: null, ownerRenounced: null, hasMintFunction: false });
  });

  describe('owner() TronGrid did not run is a failed read, never "no owner()"', () => {
    const noOwnerCode = { ...fixture<Record<string, unknown>>('tron-getcontract.json'), bytecode: '6080604052636fdde0314' };
    /** owner() answered by `reply`, the rest as a plain TRC-20 */
    const grid = (reply: ReturnType<Handler>): Handler => {
      const rest = trongrid({ 'symbol()': encString('Z') }, noOwnerCode);
      return (url, req, body) => ((body as { function_selector?: string })?.function_selector === 'owner()' ? reply : rest(url, req, body));
    };

    it.each([
      ['HTTP 429', { status: 429, json: { Error: 'request rate exceeded the allowed_rps' } }],
      ['a 200 answer without a result', { json: { Error: 'request rate exceeded the allowed_rps' } }],
      ['SERVER_BUSY', { json: { result: { code: 'SERVER_BUSY', message: '' } } }],
      ['OTHER_ERROR', { json: { result: { code: 'OTHER_ERROR', message: 'class java.lang.NullPointerException : null' } } }],
    ])('%s: reported, owner unknown (not renounced)', async (_label, reply) => {
      const tron = createTron(testEnv(), fakeHttp(grid(reply as ReturnType<Handler>)));
      const { value, errors } = await captureErrors(() => tron.tokenInfo(USDT));
      expect(value).toMatchObject({ owner: null, ownerRenounced: null, symbol: 'Z' });
      expect(errors).toEqual([expect.stringMatching(/^tron\.tokenInfo owner: /)]);
    });

    it.each([
      ['CONTRACT_EXE_ERROR', { json: { result: { code: 'CONTRACT_EXE_ERROR', message: '5245564552542f6f70636f6465206578656375746564' } } }],
      ['a run that reverted (transaction ret FAILED)', { json: { result: { result: true }, constant_result: ['08c379a0' + word('20')], transaction: { ret: [{ ret: 'FAILED' }] } } }],
    ])('a revert (%s) is "no owner()"', async (_label, reply) => {
      const tron = createTron(testEnv(), fakeHttp(grid(reply as ReturnType<Handler>)));
      const { value, errors } = await captureErrors(() => tron.tokenInfo(USDT));
      expect(errors).toEqual([]);
      expect(value).toMatchObject({ owner: null, ownerRenounced: true });
    });
  });

  it('unknown contract → null; HTTP failure → null with lastError; malformed address → no request', async () => {
    expect(await createTron(testEnv(), fakeHttp(trongrid({}, {}))).tokenInfo(USDT)).toBeNull();
    const tron = createTron(testEnv(), fakeHttp(() => ({ status: 503, text: 'busy' })));
    expect(await tron.tokenInfo(USDT)).toBeNull();
    expect(tron.lastError).toBe('tron.tokenInfo: HTTP 503 from api.trongrid.io');
    const http = fakeHttp();
    expect(await createTron(testEnv(), http).tokenInfo('T123')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});
