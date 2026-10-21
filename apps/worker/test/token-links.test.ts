/**
 * Coin links and logos from free sources: Stage A uses the token's own metadata / GeckoTerminal when DexScreener has
 * no token info (the Kimchi case), never fails on them; logos are vetted (size, magic bytes, no SVG), stored by
 * sha256 under SCREENSHOT_DIR/logos and kept by the screenshot cleanup; the GeckoTerminal doctor probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LOGO_PATH_RE, sniffImage } from '@apecheck/core';
import { emptyLinks, reportError, type Http, type HttpRequest, type HttpResponse, type Sources, type TokenLinks, type TokenLinksSource } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { CheckRun, type PipelineDeps } from '../src/pipeline/context';
import { finishResolve, resolveStage, saveTarget } from '../src/pipeline/resolve';
import { fetchLogo, saveLogo, storeLogo } from '../src/pipeline/logo';
import { StepLogger } from '../src/pipeline/steps';
import { inside } from '../src/maintenance/shots';
import { LOGOS_BATCH, backfillLogos } from '../src/maintenance/logos';
import { probeGeckoTerminal } from '../src/doctor/gecko';
import { dexInfo, fakeSources, type FakeData } from './fakes';
import { createCheck, heuristicAi, memoryStepDeps, prisma, resetDb, testEnv, tmpDir } from './helpers';

const KIMCHI = 'CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump';
const ZAP = '0x3333333333333333333333333333333333333333';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const IMG = 'https://ipfs.io/ipfs/QmKimchiImage1111111111111111111111111111111111';

afterAll(() => prisma.$disconnect());

/** pump.fun-style metadata, as TokenLinksAdapter.metadata() returns it */
function pumpMeta(): TokenLinks {
  return { ...emptyLinks(), name: 'Kimchi', symbol: 'KIMCHI', websites: ['https://kimchi.fun'], twitter: ['https://x.com/kimchi_sol'], telegram: ['https://t.me/kimchi_sol'], image: IMG };
}

function fakeTokenLinks(o: { meta?: TokenLinks | null | 'throw' | 'slow'; gecko?: TokenLinks | null } = {}): TokenLinksSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    configured: true,
    calls,
    async metadata(chain, address) {
      calls.push(`metadata ${chain} ${address}`);
      if (o.meta === 'throw') throw new Error('rpc exploded');
      if (o.meta === 'slow') return new Promise(() => undefined);
      return o.meta ?? null;
    },
    async gecko(chain, address) {
      calls.push(`gecko ${chain} ${address}`);
      if (o.gecko === undefined) reportError('tokenLinks.gecko: HTTP 429 from api.geckoterminal.com');
      return o.gecko ?? null;
    },
  };
}

async function resolve(targetRaw: string, data: FakeData, links: TokenLinksSource | undefined, opts: { deadlineMs?: number } = {}) {
  const env = testEnv();
  const check = await createCheck(targetRaw);
  const mem = memoryStepDeps();
  const log = memoryLogger();
  const sources: Sources = fakeSources(env, data);
  if (links) sources.tokenLinks = links;
  const deps: PipelineDeps = { env, prisma, redis: mem.redis, sources, ai: heuristicAi(), browser: async () => null, log };
  const steps = new StepLogger({ prisma, redis: mem.redis, screenshotDir: env.SCREENSHOT_DIR, log }, check, Date.now());
  const run = new CheckRun(deps, check, steps, Date.now(), Date.now() + 60_000, new AbortController().signal);
  const t0 = Date.now();
  await resolveStage(run, { signal: new AbortController().signal, deadline: Date.now() + (opts.deadlineMs ?? 25_000) });
  const ms = Date.now() - t0;
  finishResolve(run);
  await saveTarget(run);
  await steps.flush();
  const target = await prisma.target.findUniqueOrThrow({ where: { id: run.targetId } });
  return { run, log, ms, texts: steps.rows.map(r => `${r.status}|${r.source ?? ''}|${r.text}`), target };
}

describe('Stage A: links from the token metadata when DexScreener has none', () => {
  beforeEach(() => resetDb());

  it('the Kimchi case: a pump.fun pair without token info gets its website and X from its own metadata', async () => {
    const links = fakeTokenLinks({ meta: pumpMeta(), gecko: null });
    const { texts, target, run } = await resolve(KIMCHI, { dexTokens: { [KIMCHI.toLowerCase()]: dexInfo({ chain: 'sol', address: KIMCHI, symbol: 'KIMCHI', name: 'Kimchi' }) } }, links);
    expect(texts).toEqual(['info|DexScreener|Contract on Solana: CSocn…pump', 'ok|On-chain|Token metadata: website kimchi.fun, X @kimchi_sol']);
    expect(links.calls).toEqual([`metadata sol ${KIMCHI}`, `gecko sol ${KIMCHI}`]);
    expect(target).toMatchObject({ domain: 'kimchi.fun', handle: 'kimchi_sol', ticker: 'KIMCHI' });
    expect(run.siteUrl).toBe('https://kimchi.fun/');
    expect(run.links).toMatchObject({ site: 'https://kimchi.fun/', x: 'https://x.com/kimchi_sol', telegram: 'https://t.me/kimchi_sol' });
    expect(run.tokenLinks?.image).toEqual({ url: IMG, source: 'On-chain' });
  });

  it('DexScreener links still win; GeckoTerminal fills what is left, each source on its own line', async () => {
    const gecko = { ...emptyLinks(), websites: ['https://other.site'], twitter: ['zapfinance'], image: 'https://assets.geckoterminal.com/zap.png' };
    const { texts, target } = await resolve(
      ZAP,
      { evmChains: { [ZAP]: 'base' }, dexTokens: { [ZAP]: dexInfo({ chain: 'base', address: ZAP, symbol: 'ZAP', websites: ['https://pump.fun/coin/x', 'https://zap.finance'] }) } },
      fakeTokenLinks({ meta: null, gecko }),
    );
    expect(texts).toEqual(['info|DexScreener|Contract on Base: 0x333…3333', 'ok|DexScreener|Token metadata: website zap.finance', 'ok|GeckoTerminal|Token metadata: X @zapfinance']);
    expect(target).toMatchObject({ domain: 'zap.finance', handle: 'zapfinance' });
  });

  it('a coin DexScreener does not know at all still gets GeckoTerminal links (and its ticker)', async () => {
    const gecko = { ...emptyLinks(), symbol: 'ZAP', websites: ['https://zap.finance'] };
    const { texts, target } = await resolve(ZAP, { evmChains: { [ZAP]: 'base' } }, fakeTokenLinks({ meta: null, gecko }));
    expect(texts).toEqual(['info|On-chain|Contract on Base: 0x333…3333', 'info|DexScreener|No trading pair found on DexScreener', 'ok|GeckoTerminal|Token metadata: website zap.finance']);
    expect(target).toMatchObject({ domain: 'zap.finance', ticker: 'ZAP', name: '$ZAP' });
  });

  it('a metadata read that throws or never answers does not fail the check, and the stage keeps its deadline', async () => {
    const dex = { dexTokens: { [KIMCHI.toLowerCase()]: dexInfo({ chain: 'sol', address: KIMCHI, symbol: 'KIMCHI' }) } };
    const thrown = await resolve(KIMCHI, dex, fakeTokenLinks({ meta: 'throw' }));
    expect(thrown.texts).toEqual(['info|DexScreener|Contract on Solana: CSocn…pump', 'info||No website in the token metadata']);
    expect(thrown.log.lines.join('\n')).toMatch(/token links: .*rpc exploded/);

    await resetDb();
    const slow = await resolve(KIMCHI, dex, fakeTokenLinks({ meta: 'slow', gecko: null }), { deadlineMs: 2_500 });
    expect(slow.ms).toBeLessThan(2_400);
    expect(slow.texts.at(-1)).toBe('info|DexScreener|No website in the token metadata');
    expect(slow.log.lines.join('\n')).toMatch(/token links: no answer before the resolve deadline/);
  });

  it('without the token-links source (old wiring), DexScreener alone as before', async () => {
    const { texts } = await resolve(KIMCHI, { dexTokens: { [KIMCHI.toLowerCase()]: dexInfo({ chain: 'sol', address: KIMCHI }) } }, undefined);
    expect(texts).toEqual(['info|DexScreener|Contract on Solana: CSocn…pump', 'info|DexScreener|No website in the token metadata']);
  });
});

/** Http that answers every request with these bytes and headers. */
function bytesHttp(body: Buffer, headers: Record<string, string> = {}, status = 200): Http & { reqs: HttpRequest[] } {
  const reqs: HttpRequest[] = [];
  async function request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    reqs.push(req);
    const cut = req.maxBytes != null && body.length > req.maxBytes;
    const b = cut ? body.subarray(0, req.maxBytes) : body;
    return { status, ok: status < 300, url, finalUrl: url, headers, text: req.binary ? '' : b.toString('utf8'), truncated: cut, ms: 1, ...(req.binary ? { body: b } : {}) };
  }
  return { request, json: async () => ({}) as never, reqs };
}

describe('logos', () => {
  it('magic bytes: png, jpeg, gif, webp; svg/html/empty are not images', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('fetchLogo: guarded binary download; SVG refused (by type and by bytes), oversized refused, non-images refused', async () => {
    const ok = bytesHttp(PNG, { 'content-type': 'image/png' });
    const got = await fetchLogo(ok, IMG);
    expect(got).toMatchObject({ ok: true, type: 'png' });
    expect(ok.reqs[0]).toMatchObject({ guard: true, binary: true, maxBytes: 1024 * 1024 + 1, timeoutMs: 8000 });

    const svgType = await fetchLogo(bytesHttp(PNG, { 'content-type': 'image/svg+xml' }), IMG);
    expect(svgType).toEqual({ ok: false, reason: 'SVG refused' });
    const svgBytes = await fetchLogo(bytesHttp(Buffer.from('<?xml version="1.0"?><svg/>'), { 'content-type': 'image/png' }), IMG);
    expect(svgBytes).toEqual({ ok: false, reason: 'SVG refused' });
    const big = await fetchLogo(bytesHttp(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), { 'content-type': 'image/png' }), IMG);
    expect(big).toEqual({ ok: false, reason: 'larger than 1024 KB' });
    const html = await fetchLogo(bytesHttp(Buffer.from('<html>blocked</html>')), IMG);
    expect(html).toEqual({ ok: false, reason: 'not a PNG, JPEG, WebP or GIF' });
    expect(await fetchLogo(bytesHttp(PNG, {}, 404), IMG)).toEqual({ ok: false, reason: 'HTTP 404' });
    expect(await fetchLogo(bytesHttp(PNG), 'data:image/png;base64,AAAA')).toEqual({ ok: false, reason: 'not an http(s) image URL' });
  });

  it('storeLogo: SCREENSHOT_DIR/logos/<sha256>.<ext>, written once', async () => {
    const dir = tmpDir('apecheck-logos-');
    const rel = await storeLogo(dir, PNG, 'png');
    expect(rel).toMatch(LOGO_PATH_RE);
    expect(fs.readFileSync(path.join(dir, rel)).equals(PNG)).toBe(true);
    expect(await storeLogo(dir, PNG, 'png')).toBe(rel);
    expect(fs.readdirSync(path.join(dir, 'logos'))).toEqual([rel.slice('logos/'.length)]);
  });

  it('saveLogo stores the merged image on the Target; a re-check keeps the stored one', async () => {
    await resetDb();
    const links = fakeTokenLinks({ meta: pumpMeta(), gecko: null });
    const { run, target } = await resolve(KIMCHI, { dexTokens: { [KIMCHI.toLowerCase()]: dexInfo({ chain: 'sol', address: KIMCHI, symbol: 'KIMCHI' }) } }, links);
    expect(target.logo).toBeNull();
    const http = bytesHttp(PNG, { 'content-type': 'image/png' });
    (run.sources as { http: Http }).http = http;
    const rel = await saveLogo(run);
    expect(rel).toMatch(LOGO_PATH_RE);
    expect((await prisma.target.findUniqueOrThrow({ where: { id: run.targetId } })).logo).toBe(rel);
    expect(fs.existsSync(path.join(run.env.SCREENSHOT_DIR, rel!))).toBe(true);
    expect(await saveLogo(run)).toBe(rel);
    expect(http.reqs).toHaveLength(1);
  });

  it('the screenshot cleanup never resolves a path inside logos/ (nor the logos folder itself)', () => {
    const dir = tmpDir('apecheck-shots-');
    expect(inside(dir, 'logos')).toBeNull();
    expect(inside(dir, 'cards')).toBeNull();
    expect(inside(dir, 'logos', 'abc.png')).toBeNull();
    expect(inside(dir, 'clx0abc123')).toBe(path.join(dir, 'clx0abc123'));
    expect(inside(dir, 'cards', 'Ab12Cd3.png')).toBe(path.join(dir, 'cards', 'Ab12Cd3.png'));
  });
});

describe('logo backfill (coins checked before logos were stored)', () => {
  it('stores the image a check would pick, skips coins with a logo, and asks a coin without an image again only after a day', async () => {
    await resetDb();
    const env = testEnv();
    const ZAP_MINT = 'ZapMint1111111111111111111111111111111111111';
    const coin = (ca: string, chain: 'SOL' | 'BASE', logo: string | null = null) =>
      prisma.target.create({ data: { kind: 'COIN', chain, ca, name: ca.slice(0, 6), key: `ca:${chain.toLowerCase()}:${ca}`, logo, lastCheckedAt: new Date() } });
    const kimchi = await coin(KIMCHI, 'SOL');
    const zap = await coin(ZAP, 'BASE');
    const bare = await coin(ZAP_MINT, 'SOL');
    const has = await coin('HasLogo11111111111111111111111111111111111', 'SOL', 'logos/' + 'a'.repeat(64) + '.png');
    await prisma.target.create({ data: { kind: 'SITE', domain: 'kairo.app', name: 'kairo.app', key: 'site:kairo.app' } });

    // KIMCHI: no DexScreener info, its pump.fun metadata has the image; ZAP: DexScreener's image; the third has none
    const sources = fakeSources(env, { dexTokens: { [ZAP.toLowerCase()]: dexInfo({ chain: 'base', address: ZAP, imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/base/zap.png' }) } });
    const asked: string[] = [];
    sources.tokenLinks = {
      configured: true,
      async metadata(_chain, address) {
        asked.push(address);
        return address === KIMCHI ? pumpMeta() : null;
      },
      async gecko() {
        return null;
      },
    };
    const http = bytesHttp(PNG, { 'content-type': 'image/png' });
    (sources as { http: Http }).http = http;
    const tried = new Map<string, number>();
    let now = Date.now();
    const run = () => backfillLogos({ prisma, sources, screenshotDir: env.SCREENSHOT_DIR, log: memoryLogger(), tried, now: () => now });

    expect(await run()).toEqual({ stored: 2, missing: 1 });
    const logo = async (id: string) => (await prisma.target.findUniqueOrThrow({ where: { id } })).logo;
    expect(await logo(kimchi.id)).toMatch(LOGO_PATH_RE);
    expect(await logo(zap.id)).toMatch(LOGO_PATH_RE);
    expect(await logo(bare.id)).toBeNull();
    expect(await logo(has.id)).toBe('logos/' + 'a'.repeat(64) + '.png');
    // ZAP never needed the metadata: DexScreener had the image
    expect(asked.sort()).toEqual([KIMCHI, ZAP_MINT].sort());
    expect(http.reqs).toHaveLength(2);

    // the coin without an image waits a day
    asked.length = 0;
    expect(await run()).toEqual({ stored: 0, missing: 0 });
    expect(asked).toEqual([]);
    now += 25 * 3600_000;
    expect(await run()).toEqual({ stored: 0, missing: 1 });
    expect(asked).toEqual([ZAP_MINT]);
    expect(LOGOS_BATCH).toBeGreaterThan(0);
  });
});

describe('migration', () => {
  it('Target.logo exists as a nullable text column (additive)', async () => {
    const rows = await prisma.$queryRaw<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'Target' AND column_name = 'logo'`;
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });
});

describe('doctor: GeckoTerminal probe', () => {
  it('PASS with the token info, WARN (optional source) when it fails', async () => {
    const good = fakeTokenLinks({ gecko: { ...emptyLinks(), symbol: 'PEPE', websites: ['https://pepe.vip'], twitter: ['pepecoineth'], image: 'https://a/b.png' } });
    expect(await probeGeckoTerminal({ tokenLinks: good })).toEqual({ status: 'PASS', detail: 'api.geckoterminal.com: PEPE token info, symbol PEPE, 1 website(s), X handle, image' });
    const down = await probeGeckoTerminal({ tokenLinks: fakeTokenLinks() });
    expect(down.status).toBe('WARN');
    expect(down.detail).toMatch(/HTTP 429/);
    expect(down.remedy).toMatch(/rate-limits/);
    expect((await probeGeckoTerminal({})).status).toBe('WARN');
  });
});
