/**
 * Token links from free sources: Solana token metadata (Helius DAS, Metaplex PDA, Token-2022 extension) and its JSON,
 * GeckoTerminal token info, link normalisation/rejection and the DexScreener > metadata > GeckoTerminal merge.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDexScreener } from '../src/adapters/dexscreener';
import { createTokenLinks, parseGeckoInfo, parseMetadataJson } from '../src/adapters/token-links';
import { createHttp } from '../src/http';
import { gatewayUrl, imageUrlOf, linksFromDex, mergeTokenLinks, projectWebsiteOf, telegramUrlOf, xHandleOf } from '../src/links';
import { decodeMetaplexMetadata, isOnCurve, metadataPda } from '../src/solana-pda';
import { base58Decode } from '../src/base58';
import { captureErrors } from '../src/util';
import { fakeHttp, fixture, rpcHandler, testEnv, type Handler } from './helpers';

const KIMCHI = 'CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump';
const ZAP = '0x3333333333333333333333333333333333333333';
const META_URI = 'https://ipfs.io/ipfs/QmKimchiMetadata11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** A Metaplex MetadataV1 account (key, update authority, mint, name/symbol/uri padded like the program does). */
function metaplexAccount(mint: string, name: string, symbol: string, uri: string): string {
  const pad = (s: string, n: number) => {
    const b = Buffer.alloc(4 + n);
    b.writeUInt32LE(n, 0);
    Buffer.from(s, 'utf8').copy(b, 4);
    return b;
  };
  return Buffer.concat([Buffer.of(4), Buffer.alloc(32, 7), base58Decode(mint)!, pad(name, 32), pad(symbol, 10), pad(uri, 200), Buffer.alloc(40)]).toString('base64');
}

const metaJson: Handler = url => (url.href === META_URI ? { json: fixture('pumpfun-metadata.json') } : undefined);

describe('links: normalisation and rejection', () => {
  it('X handle from a profile link or @handle; posts, intents, searches and other hosts are not profiles', () => {
    expect(xHandleOf('https://x.com/kimchi_sol')).toBe('kimchi_sol');
    expect(xHandleOf('https://twitter.com/ZapFinance/')).toBe('ZapFinance');
    expect(xHandleOf('twitter.com/zap?s=21')).toBe('zap');
    expect(xHandleOf('@kimchi_sol')).toBe('kimchi_sol');
    expect(xHandleOf('zapfinance')).toBe('zapfinance');
    expect(xHandleOf('https://x.com/kimchi_sol/status/1849001')).toBeNull();
    expect(xHandleOf('https://x.com/i/communities/1849')).toBeNull();
    expect(xHandleOf('https://x.com/intent/tweet?text=hi')).toBeNull();
    expect(xHandleOf('https://twitter.com/share?url=x')).toBeNull();
    expect(xHandleOf('https://x.com/search?q=%24KIMCHI')).toBeNull();
    expect(xHandleOf('https://x.com/home')).toBeNull();
    expect(xHandleOf('https://x.com/hashtag/kimchi')).toBeNull();
    expect(xHandleOf('https://notx.com/kimchi')).toBeNull();
    expect(xHandleOf('a_handle_that_is_far_too_long')).toBeNull();
    expect(xHandleOf('')).toBeNull();
  });

  it('project website: absolute https URL; launchpads, explorers, aggregators, socials and link hubs are rejected', () => {
    expect(projectWebsiteOf('https://kimchi.fun')).toBe('https://kimchi.fun/');
    expect(projectWebsiteOf('kimchi.fun/about')).toBe('https://kimchi.fun/about');
    for (const bad of [
      'https://pump.fun/coin/CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump',
      'https://letsbonk.fun/token/abc',
      'https://moonshot.money/abc',
      'https://dexscreener.com/solana/abc',
      'https://gmgn.ai/sol/token/abc',
      'https://birdeye.so/token/abc',
      'https://solscan.io/token/abc',
      'https://etherscan.io/token/0x1',
      'https://bscscan.com/token/0x1',
      'https://basescan.org/token/0x1',
      'https://arbiscan.io/token/0x1',
      'https://www.geckoterminal.com/solana/pools/abc',
      'https://www.coingecko.com/en/coins/abc',
      'https://t.me/kimchi',
      'https://x.com/kimchi',
      'https://twitter.com/kimchi',
      'https://discord.gg/abc',
      'https://linktr.ee/kimchi',
      'https://ipfs.io/ipfs/QmX',
      'javascript:alert(1)',
      'ftp://kimchi.fun',
      'https://user:pw@kimchi.fun',
      'https://10.0.0.1/',
      'not a url',
    ]) {
      expect(projectWebsiteOf(bad), bad).toBeNull();
    }
  });

  it('telegram, gateways and images', () => {
    expect(telegramUrlOf('zapfinance')).toBe('https://t.me/zapfinance');
    expect(telegramUrlOf('https://t.me/kimchi_sol')).toBe('https://t.me/kimchi_sol');
    expect(telegramUrlOf('https://kimchi.fun')).toBeNull();
    expect(gatewayUrl('ipfs://QmAbc/meta.json')).toBe('https://ipfs.io/ipfs/QmAbc/meta.json');
    expect(gatewayUrl('ipfs://ipfs/QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
    expect(gatewayUrl('ar://abc')).toBe('https://arweave.net/abc');
    expect(gatewayUrl('file:///etc/passwd')).toBeNull();
    expect(imageUrlOf('missing.png')).toBeNull();
    expect(imageUrlOf('https://assets.geckoterminal.com/missing.png')).toBeNull();
    expect(imageUrlOf('data:image/svg+xml;base64,AAAA')).toBeNull();
  });

  it('merge: DexScreener > token metadata > GeckoTerminal per field, rejected values skipped', () => {
    const dex = linksFromDex({ websites: ['https://pump.fun/coin/x'], socials: [{ type: 'twitter', url: 'https://x.com/dexhandle' }], imageUrl: null });
    const meta = parseMetadataJson(fixture('pumpfun-metadata.json'));
    const gecko = parseGeckoInfo(fixture('geckoterminal-token-info.json'));
    const m = mergeTokenLinks([
      { source: 'DexScreener', links: dex },
      { source: 'On-chain', links: meta },
      { source: 'GeckoTerminal', links: gecko },
    ]);
    expect(m.website).toEqual({ url: 'https://kimchi.fun/', source: 'On-chain' });
    expect(m.x).toEqual({ handle: 'dexhandle', source: 'DexScreener' });
    expect(m.telegram).toEqual({ url: 'https://t.me/kimchi_sol', source: 'On-chain' });
    expect(m.discord).toEqual({ url: 'https://discord.gg/zapfi', source: 'GeckoTerminal' });
    expect(m.image).toEqual({ url: 'https://ipfs.io/ipfs/QmKimchiImage1111111111111111111111111111111111', source: 'On-chain' });
    // nothing anywhere
    expect(mergeTokenLinks([{ source: 'DexScreener', links: null }])).toEqual({ website: null, x: null, telegram: null, discord: null, image: null });
  });

  it('a DexScreener pair without token info gives no links (the Kimchi case)', async () => {
    const dexHttp = fakeHttp(url => (url.pathname === `/tokens/v1/solana/${KIMCHI}` ? { json: fixture('dexscreener-pair-no-info.json') } : undefined));
    const info = await createDexScreener(testEnv(), dexHttp).token('sol', KIMCHI);
    expect(info).toMatchObject({ symbol: 'KIMCHI', websites: [], socials: [], imageUrl: null });
    expect(mergeTokenLinks([{ source: 'DexScreener', links: linksFromDex(info) }])).toEqual({ website: null, x: null, telegram: null, discord: null, image: null });
  });
});

describe('Solana PDA and Metaplex decoding', () => {
  it('derives the Metaplex metadata PDA of a mint (RAY, checked against mainnet)', () => {
    expect(metadataPda('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R')).toBe('GMrwFHibMxDtx4aPznekZ7RoJLZGzzLGRSWeNTf3XV2');
    expect(isOnCurve(base58Decode('GMrwFHibMxDtx4aPznekZ7RoJLZGzzLGRSWeNTf3XV2')!)).toBe(false);
    // a wallet key is a curve point
    expect(isOnCurve(base58Decode('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')!)).toBe(true);
    expect(metadataPda('not-base58!')).toBeNull();
  });

  it('decodes name, symbol and uri of a MetadataV1 account (NUL padding trimmed)', () => {
    const acc = Buffer.from(metaplexAccount(KIMCHI, 'Kimchi', 'KIMCHI', META_URI), 'base64');
    expect(decodeMetaplexMetadata(acc)).toEqual({ mint: KIMCHI, name: 'Kimchi', symbol: 'KIMCHI', uri: META_URI });
    expect(decodeMetaplexMetadata(acc.subarray(0, 70))).toBeNull();
    expect(decodeMetaplexMetadata(Buffer.concat([Buffer.of(9), acc.subarray(1)]))).toBeNull();
  });
});

describe('token metadata (Solana)', () => {
  it('with HELIUS_API_KEY: DAS getAsset, then the JSON at json_uri (guarded, 256 KB)', async () => {
    const http = fakeHttp(
      (url, _req, body) => (url.host === 'mainnet.helius-rpc.com' && (body as { method?: string })?.method === 'getAsset' ? { json: fixture('helius-das-getasset.json') } : undefined),
      metaJson,
    );
    const links = await createTokenLinks(testEnv({ HELIUS_API_KEY: 'k' }), http).metadata('sol', KIMCHI);
    expect(links).toMatchObject({
      name: 'Kimchi',
      symbol: 'KIMCHI',
      websites: ['https://kimchi.fun'],
      twitter: ['https://x.com/kimchi_sol'],
      telegram: ['https://t.me/kimchi_sol'],
      image: 'https://ipfs.io/ipfs/QmKimchiImage1111111111111111111111111111111111',
    });
    const jsonCall = http.calls.find(c => c.url === META_URI)!;
    expect(jsonCall.req).toMatchObject({ guard: true, maxBytes: 256 * 1024, timeoutMs: 8000 });
    expect((http.calls[0].body as { params: unknown }).params).toEqual({ id: KIMCHI });
  });

  it('without Helius: one getMultipleAccounts for the mint and its metadata PDA, then the JSON', async () => {
    const pda = metadataPda(KIMCHI)!;
    let asked: unknown;
    const http = fakeHttp(
      rpcHandler('api.mainnet-beta.solana.com', {
        getMultipleAccounts: params => {
          asked = params[0];
          return {
            context: { slot: 1 },
            value: [
              { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6 } } } },
              { owner: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', data: [metaplexAccount(KIMCHI, 'Kimchi', 'KIMCHI', META_URI), 'base64'] },
            ],
          };
        },
      }),
      metaJson,
    );
    const links = await createTokenLinks(testEnv(), http).metadata('sol', KIMCHI);
    expect(asked).toEqual([KIMCHI, pda]);
    expect(links).toMatchObject({ name: 'Kimchi', websites: ['https://kimchi.fun'], twitter: ['https://x.com/kimchi_sol'] });
  });

  it('DAS failing falls back to the accounts', async () => {
    const http = fakeHttp(
      (url, _req, body) => {
        if (url.host !== 'mainnet.helius-rpc.com') return undefined;
        const b = body as { method: string; id: unknown };
        if (b.method === 'getAsset') return { status: 500, text: 'down' };
        return {
          json: {
            jsonrpc: '2.0',
            id: b.id,
            result: { value: [null, { owner: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', data: [metaplexAccount(KIMCHI, 'Kimchi', 'KIMCHI', META_URI), 'base64'] }] },
          },
        };
      },
      metaJson,
    );
    const r = await captureErrors(() => createTokenLinks(testEnv({ HELIUS_API_KEY: 'k' }), http).metadata('sol', KIMCHI));
    expect(r.value?.websites).toEqual(['https://kimchi.fun']);
    expect(r.errors[0]).toMatch(/^tokenLinks\.das: HTTP 500/);
  });

  it('Token-2022: the tokenMetadata extension (uri and additionalMetadata)', async () => {
    const http = fakeHttp(
      rpcHandler('api.mainnet-beta.solana.com', {
        getMultipleAccounts: () => ({
          value: [
            {
              owner: TOKEN_2022,
              data: {
                parsed: {
                  type: 'mint',
                  info: {
                    extensions: [
                      { extension: 'metadataPointer', state: { authority: null, metadataAddress: KIMCHI } },
                      { extension: 'tokenMetadata', state: { name: 'Kimchi', symbol: 'KIMCHI', uri: 'ipfs://QmKimchiMetadata11111111111111111111111111111111', additionalMetadata: [['discord', 'https://discord.gg/kimchi']] } },
                    ],
                  },
                },
              },
            },
            null,
          ],
        }),
      }),
      metaJson,
    );
    const links = await createTokenLinks(testEnv(), http).metadata('sol', KIMCHI);
    expect(links).toMatchObject({ websites: ['https://kimchi.fun'], discord: ['https://discord.gg/kimchi'] });
  });

  it('metadata JSON over the size cap, or not JSON: no links, the reason reported', async () => {
    const big = fakeHttp(
      (url, _req, body) => (url.host === 'mainnet.helius-rpc.com' && (body as { method?: string })?.method === 'getAsset' ? { json: fixture('helius-das-getasset.json') } : undefined),
      url => (url.href === META_URI ? { text: '<html>gateway error</html>' } : undefined),
    );
    const r = await captureErrors(() => createTokenLinks(testEnv({ HELIUS_API_KEY: 'k' }), big).metadata('sol', KIMCHI));
    // the DAS image still counts
    expect(r.value).toMatchObject({ websites: [], twitter: [], image: 'https://ipfs.io/ipfs/QmKimchiImage1111111111111111111111111111111111' });
    expect(r.errors).toEqual(['tokenLinks.metadataJson: metadata is not JSON']);
  });

  it('extensions-style JSON (website / twitter under "extensions")', () => {
    const links = parseMetadataJson({ name: 'Zap', image: 'ipfs://QmZap', extensions: { website: 'https://zap.finance', twitter: 'https://twitter.com/zapfinance', telegram: 'zapfinance' } });
    expect(links).toMatchObject({ websites: ['https://zap.finance'], twitter: ['https://twitter.com/zapfinance'], telegram: ['zapfinance'], image: 'ipfs://QmZap' });
    expect(parseMetadataJson('nope')).toBeNull();
    expect(parseMetadataJson([1, 2])).toBeNull();
  });

  it('EVM / Tron tokens have no link metadata on-chain: no call', async () => {
    const http = fakeHttp();
    expect(await createTokenLinks(testEnv(), http).metadata('base', ZAP)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('GeckoTerminal token info', () => {
  it('GET /networks/{network}/tokens/{address}/info with tolerant parsing', async () => {
    const http = fakeHttp(url => (url.pathname === `/api/v2/networks/base/tokens/${ZAP}/info` ? { json: fixture('geckoterminal-token-info.json') } : undefined));
    const links = await createTokenLinks(testEnv(), http).gecko('base', ZAP);
    expect(http.calls[0].url).toBe(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${ZAP}/info`);
    expect(http.calls[0].req.timeoutMs).toBe(8000);
    expect(links).toEqual({
      name: 'Zap Finance',
      symbol: 'ZAP',
      description: 'Zap is a swap aggregator on Base.',
      websites: ['https://zap.finance', 'https://docs.zap.finance'],
      twitter: ['zapfinance'],
      telegram: ['zapfinance'],
      discord: ['https://discord.gg/zapfi'],
      image: 'https://assets.geckoterminal.com/abc123/zap-large.png',
    });
  });

  it('maps ApeCheck chains to network ids; Robinhood Chain is not asked', async () => {
    const http = fakeHttp(() => ({ json: fixture('geckoterminal-token-info-bare.json') }));
    const src = createTokenLinks(testEnv(), http);
    await src.gecko('sol', KIMCHI);
    await src.gecko('bnb', ZAP);
    await src.gecko('arb', ZAP);
    await src.gecko('eth', ZAP);
    expect(await src.gecko('rh', ZAP)).toBeNull();
    expect(http.calls.map(c => new URL(c.url).pathname.split('/')[4])).toEqual(['solana', 'bsc', 'arbitrum', 'eth']);
  });

  it('a placeholder image and empty lists merge to nothing; 404 is not an error; junk is', async () => {
    const bare = parseGeckoInfo(fixture('geckoterminal-token-info-bare.json'));
    expect(mergeTokenLinks([{ source: 'GeckoTerminal', links: bare }])).toEqual({ website: null, x: null, telegram: null, discord: null, image: null });
    const http404 = fakeHttp(() => ({ status: 404, json: { errors: [{ status: '404', title: 'Not Found' }] } }));
    const r = await captureErrors(() => createTokenLinks(testEnv(), http404).gecko('sol', KIMCHI));
    expect(r).toEqual({ value: null, errors: [] });
    const junk = fakeHttp(() => ({ json: { data: 'x' } }));
    const j = await captureErrors(() => createTokenLinks(testEnv(), junk).gecko('sol', KIMCHI));
    expect(j.value).toBeNull();
    expect(j.errors[0]).toMatch(/^tokenLinks\.gecko: unexpected response shape/);
    // wrong field types are skipped, not fatal
    expect(parseGeckoInfo({ data: { attributes: { websites: 'x', twitter_handle: 5, image_url: 'https://a.b/c.png' } } })).toMatchObject({ websites: [], twitter: [], image: 'https://a.b/c.png' });
  });
});

describe('http binary bodies', () => {
  let server: http.Server;
  let host = '';
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80])));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('binary: true keeps the raw bytes (no UTF-8 decoding)', async () => {
    const client = createHttp(testEnv({ SSRF_ALLOW_HOSTS: host }));
    const res = await client.request(`http://${host}/logo.png`, { guard: true, binary: true });
    expect(res.text).toBe('');
    expect([...res.body!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
    const plain = await client.request(`http://${host}/logo.png`, { guard: true });
    expect(plain.body).toBeUndefined();
  });
});
