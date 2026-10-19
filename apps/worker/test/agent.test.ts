/**
 * Stage B on every fixture site with the heuristic agent, in real Chromium behind the real SSRF guard
 * proxy: expected launch / flow / docs signals and one screenshot per browser step.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicAi, ResilientAi, type AnthropicClientLike } from '../src/ai';
import { Explorer } from '../src/browser/agent';
import { BrowserHost } from '../src/browser/browser';
import { clampPageText, clampProbe, clampSummary, domSummary, openSite, pageText, probe } from '../src/browser/page';
import { browseStage, recoverLateTx } from '../src/pipeline/browse';
import { productSignals } from '../src/pipeline/signals';
import { challengeHandler, closedPort, hostileHandler, serveFixture, serveHandler, testLookup, type FixtureSite } from './fixture-server';
import { fakeSources } from './fakes';
import { heuristicAi, standaloneRun, testEnv } from './helpers';

const NAMES = [
  'working-app', 'waitlist', 'dead-button', 'coming-soon-flow', 'broken-docs', 'noisy-dead', 'picker-app',
  'coming-soon-connect', 'waitlist-connect', 'dead-launch-connect', 'dialog-swap', 'wrong-chain',
] as const;
const sites = new Map<string, FixtureSite>();
let host: BrowserHost;
let neverHost: string;
let env: ReturnType<typeof testEnv>;

beforeAll(async () => {
  for (const n of NAMES) sites.set(n, await serveFixture(n));
  sites.set('cf-challenge', await serveHandler('cf-challenge', challengeHandler('challenge')));
  sites.set('plain-403', await serveHandler('plain-403', challengeHandler('plain403')));
  sites.set('hostile', await serveHandler('hostile', hostileHandler()));
  neverHost = `never-loads.test:${await closedPort()}`;
  env = testEnv({ SSRF_ALLOW_HOSTS: [...[...sites.values()].map(s => s.host), neverHost].join(',') });
  host = await BrowserHost.launch({ env, lookup: testLookup });
});

afterAll(async () => {
  await host?.close();
  for (const s of sites.values()) await s.close();
});

async function browse(url: string, ai?: ResilientAi) {
  const sources = fakeSources(env);
  const { run, steps } = standaloneRun({ env, sources, browser: host, ai });
  run.siteUrl = url;
  run.domain = new URL(url).hostname;
  await browseStage(run);
  await steps.flush();
  return { run, rows: steps.rows, sources };
}

describe('browser agent on fixture sites (heuristic AI)', () => {
  it('working-app: app opens, wallet connects, the swap reaches a simulated transaction, docs are deep', async () => {
    const { run, rows, sources } = await browse(sites.get('working-app')!.url);
    const p = run.product!;
    expect(p.launch.signal).toBe('ok');
    expect(p.flow.signal).toBe('ok');
    expect(p.docs.signal).toBe('ok');
    expect(p.flow.text).toMatch(/simulates fine/);
    expect(rows.some(r => r.text === 'Main flow reached a transaction; simulation succeeded')).toBe(true);
    // the burner is the sender, the dapp's payload is what gets simulated
    expect(sources.simulated[0]).toMatchObject({ from: '0x4bb0dc5d1f2a2d4e8d8bd4a9e0bc6f8c7c2b3a10', to: '0x2626664c2603336e57b271c5c0b26f421741e481', data: '0x04e45aaf' });
    expect(run.docs.result!.pages).toBeGreaterThanOrEqual(3);
    expect(run.docs.result!.lastUpdated).not.toBeNull();
    expect(run.links.github).toContain('https://github.com/orbitswap/core');
    expect(run.handle).toBe('orbitswap');
    expect(run.landing!.hero).toMatch(/Live on Base mainnet/);
    expect(run.landing!.footer).toMatch(/Fair launch/);
    // every browser action step carries a screenshot and a caption
    const shots = rows.filter(r => r.screenshot);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    expect(rows.find(r => r.caption === "Clicking 'Launch app'")).toBeTruthy();
    expect(rows.find(r => r.caption === 'Trying the main flow')).toBeTruthy();
    expect(rows.find(r => r.caption === 'Opening docs')?.text).toMatch(/^Docs: \d+ pages/);
  });

  it('waitlist: Launch app opens a waitlist form → launch warn', async () => {
    const { run, rows } = await browse(sites.get('waitlist')!.url);
    expect(run.product!.launch.signal).toBe('warn');
    expect(run.product!.launch.text).toBe("'Launch app' opens a waitlist form");
    expect(run.product!.flow.signal).toBe('warn');
    expect(run.product!.docs.signal).toBe('warn');
    expect(rows.some(r => r.text === "'Launch app' opens a waitlist form" && r.status === 'warn' && r.screenshot)).toBe(true);
  });

  it('dead-button: Launch app does nothing → launch fail', async () => {
    const { run } = await browse(sites.get('dead-button')!.url);
    expect(run.product!.launch.signal).toBe('fail');
    expect(run.product!.launch.text).toBe("'Launch app' does nothing when clicked");
    expect(run.product!.docs.signal).toBe('warn');
    expect(run.product!.docs.text).toBe('Docs: a single page with no technical detail');
  });

  it("coming-soon-flow: app opens, main flow stops at 'Coming soon' → flow warn", async () => {
    const { run } = await browse(sites.get('coming-soon-flow')!.url);
    expect(run.product!.launch.signal).toBe('ok');
    expect(run.product!.flow.signal).toBe('warn');
    expect(run.product!.flow.text).toBe("Main flow stops at a 'Coming soon' screen");
    expect(run.product!.causes.comingSoon).toBe(true);
  });

  it('broken-docs: docs link 404 → docs fail', async () => {
    const { run } = await browse(sites.get('broken-docs')!.url);
    expect(run.product!.launch.signal).toBe('ok');
    expect(run.product!.docs.signal).toBe('fail');
    expect(run.product!.docs.text).toBe('Docs: link returns 404');
  });

  it('a dead button on a busy page (tickers, feeds) is still dead', async () => {
    const { run } = await browse(sites.get('noisy-dead')!.url);
    expect(run.product!.launch).toMatchObject({ signal: 'fail', text: "'Launch app' does nothing when clicked" });
  });

  it('wallet picker (EIP-6963): picks the injected wallet, fills an amount, reaches the transaction on the switched chain', async () => {
    const { run, rows, sources } = await browse(sites.get('picker-app')!.url);
    expect(rows.map(r => r.text)).toEqual(expect.arrayContaining(["'Connect Wallet' opens a wallet picker", "'MetaMask' asked the test wallet to connect", 'Main flow reached a transaction; simulation succeeded']));
    expect(sources.calls).toContain('evm.simulate base');
    expect(sources.simulated[0]).toMatchObject({ to: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', value: '0x38d7ea4c68000' });
    expect([run.product!.launch.signal, run.product!.flow.signal]).toEqual(['ok', 'ok']);
  });

  it("'Launch app' opens 'Coming soon' and only a header Connect wallet works → launch warn, not ok", async () => {
    const { run, rows } = await browse(sites.get('coming-soon-connect')!.url);
    expect(rows.map(r => r.text)).toEqual(expect.arrayContaining(["'Launch app' shows 'Coming soon'", "'Connect wallet' asked the test wallet to connect"]));
    expect(run.product!.launch).toMatchObject({ signal: 'warn', text: "'Launch app' shows 'Coming soon' (only the wallet connect works)" });
    expect(run.product!.flow.signal).toBe('warn');
    expect(run.product!.causes.comingSoon).toBe(true);
  });

  it('a Connect wallet that joins a waitlist is not an app → launch warn', async () => {
    const { run, rows } = await browse(sites.get('waitlist-connect')!.url);
    expect(rows.some(r => r.text === "'Connect wallet' opens a waitlist form")).toBe(true);
    expect(run.explored!.appReached).toBe(false);
    expect(run.product!.launch).toMatchObject({ signal: 'warn', text: "'Connect wallet' opens a waitlist form" });
    expect(run.product!.plain.launch).not.toMatch(/App opened/);
  });

  it('a dead Launch app next to a working Connect wallet → launch fail', async () => {
    const { run } = await browse(sites.get('dead-launch-connect')!.url);
    expect(run.product!.launch.signal).toBe('fail');
    expect(run.product!.launch.text).toMatch(/^'Launch app' does nothing when clicked/);
    expect(run.product!.causes.deadLaunch).toBe(true);
  });

  it('a main button that only opens a token dialog is not a working flow → flow warn', async () => {
    const { run, rows } = await browse(sites.get('dialog-swap')!.url);
    expect(run.product!.launch.signal).toBe('ok');
    expect(rows.some(r => r.text === "'Swap' opens a dialog; no transaction or signature followed")).toBe(true);
    expect(rows.some(r => /responded without errors/.test(r.text))).toBe(false);
    expect(run.product!.flow).toMatchObject({ signal: 'warn', text: "The main action opened a dialog; the flow wasn't completed" });
    expect(run.explored!.mainOk).toBeNull();
  });

  it('a transaction on a chain we do not know is not simulated (never on Ethereum) → flow warn', async () => {
    const { run, rows, sources } = await browse(sites.get('wrong-chain')!.url);
    expect(sources.calls.filter(c => c.startsWith('evm.simulate'))).toEqual([]);
    expect(rows.some(r => r.text === "Main flow reached a transaction; it could not be simulated (it targets a chain ApeCheck can't simulate (chain id 137))")).toBe(true);
    expect(run.explored!.tx).toMatchObject({ reached: true, simulated: 'skipped', chain: null });
    expect(run.product!.flow.signal).toBe('warn');
  });

  it('a Cloudflare bot challenge is "could not be checked" (warn), a plain 403 still fails', async () => {
    const { run, rows } = await browse(sites.get('cf-challenge')!.url);
    expect(run.site.loaded).toBe(false);
    expect(run.site.infraError).toBe('the site blocks automated browsers');
    expect(rows.some(r => r.status === 'warn' && /blocks automated browsers \(Cloudflare bot challenge\); the site could not be checked$/.test(r.text))).toBe(true);
    expect(rows.some(r => /didn't load/.test(r.text))).toBe(false);
    expect([run.product!.launch.signal, run.product!.flow.signal]).toEqual(['warn', 'warn']);
    expect(run.product!.causes.unchecked).toBe(true);
    expect(run.degraded).toContain('browse:blocked');

    const plain = await browse(sites.get('plain-403')!.url);
    expect(plain.run.product!.launch).toMatchObject({ signal: 'fail', text: "The site didn't load (HTTP 403)" });
    expect(plain.run.product!.causes.unchecked).toBe(false);
  }, 60_000);

  it('a hostile page cannot defeat the length caps: reads run in an isolated world and are clamped again', async () => {
    const session = await host.newSession({ evmChainId: '0x1' });
    try {
      const o = await openSite(session, sites.get('hostile')!.url, 15_000);
      expect(o.loaded).toBe(true);
      const p = await probe(o.page);
      expect(p.text.length).toBeLessThanOrEqual(30_000);
      expect(p.text).toMatch(/^Hi/);
      expect(p.text).not.toMatch(/EVIL/);
      expect(p.textLen).toBeGreaterThan(1_000_000);
      expect(p.title.length).toBeLessThanOrEqual(160);
      const t = (await pageText(o.page))!;
      expect(t.text.length).toBeLessThanOrEqual(20_000);
      expect(t.hero.length).toBeLessThanOrEqual(6000);
      expect(t.title.length).toBeLessThanOrEqual(160);
      expect(t.title).not.toContain('\u0000');
      expect(t.links.every(l => l.href.length <= 500)).toBe(true);
      const d = await domSummary(o.page);
      expect(d.title.length).toBeLessThanOrEqual(160);
      expect(d.elements.find(e => e.text === 'Launch app')?.href?.length).toBeLessThanOrEqual(500);
    } finally {
      await session.close();
    }
    // the Node-side clamps hold even when a value arrives oversized or mistyped
    const huge = 'x'.repeat(100_000);
    const p = clampProbe({ url: huge, title: huge, text: huge, textLen: 'NaN', modalText: huge, added: Infinity, h1: { a: 1 }, emailInput: 'yes' }, 'http://f/');
    expect([p.url.length, p.title.length, p.text.length, p.modalText!.length, p.h1, p.textLen, p.added, p.emailInput]).toEqual([2000, 160, 30_000, 1500, '', 0, 0, false]);
    const t = clampPageText({ title: huge, hero: huge, footer: huge, text: huge, links: Array.from({ length: 900 }, () => ({ href: huge, text: huge })), modified: huge, times: Array.from({ length: 50 }, () => huge), codeBlocks: 3 })!;
    expect([t.title.length, t.hero.length, t.footer.length, t.text.length, t.links.length, t.links[0].href.length, t.links[0].text.length, t.modified!.length, t.times.length, t.times[0]!.length]).toEqual([160, 6000, 3000, 20_000, 500, 500, 80, 100, 20, 100]);
    const d = clampSummary({ title: huge, elements: Array.from({ length: 500 }, (_, i) => ({ id: i + 1, kind: 'link', text: huge + '\u0000', href: huge })), headings: Array.from({ length: 50 }, () => huge) }, 'http://f/');
    expect([d.title.length, d.elements.length, d.elements[0].text.length, d.elements[0].href!.length, d.headings.length]).toEqual([160, 80, 80, 500, 10]);
    expect(clampPageText('not an object')).toBeNull();
  });

  it('a transaction still being simulated when the explore stage ends is kept as "not simulated in time", never applied late', async () => {
    const sources = fakeSources(env);
    const { run, steps } = standaloneRun({ env, sources, browser: host });
    run.siteUrl = sites.get('working-app')!.url;
    run.session = await host.newSession({ evmChainId: '0x2105' });
    try {
      await run.session.newPage().then(p => p.goto(run.siteUrl!, { waitUntil: 'domcontentloaded' }));
      const ctrl = new AbortController();
      const explorer = new Explorer({
        session: run.session, ai: heuristicAi(), steps: steps.scoped(ctrl.signal), siteUrl: run.siteUrl, maxActions: 6,
        deadline: Date.now() + 60_000, signal: ctrl.signal,
        // the stage ends while the simulation is running; the simulation then reports success
        simulate: async () => {
          ctrl.abort();
          await new Promise(r => setTimeout(r, 300));
          return { status: 'ok', detail: null, needsFunds: false, chain: 'base' };
        },
      });
      run.explorer = explorer;
      const finished = explorer.run();
      while (!ctrl.signal.aborted) await new Promise(r => setTimeout(r, 20));
      run.explored = explorer.snapshot();
      await finished;
      // the late simulation changed nothing and logged nothing
      expect(explorer.result.tx).toBeNull();
      expect(run.explored.tx).toBeNull();
      await steps.flush();
      expect(steps.rows.some(r => /simulation succeeded/.test(r.text))).toBe(false);
      // the captured transaction is recorded with its own step, cited by the flow signal
      await recoverLateTx(run, '0x2105');
      await steps.flush();
      const step = steps.rows.find(r => r.text === 'Main flow reached a transaction; it was not simulated in time')!;
      expect(step).toBeTruthy();
      expect(run.explored.tx).toMatchObject({ reached: true, simulated: 'skipped', detail: 'not simulated in time', chain: 'base', stepIdx: step.idx });
      run.site = { ...run.site, hasSite: true, loaded: true };
      const p = productSignals(run.site, run.explored, run.docs);
      expect(p.flow).toMatchObject({ signal: 'warn', text: "Main flow reached a transaction; it couldn't be simulated (not simulated in time)", stepIdx: step.idx });
      expect(p.launch.stepIdx).not.toBe(-1);
    } finally {
      await run.session.close();
    }
  });

  it('a site that never loads → launch fail', async () => {
    const { run, rows } = await browse(`http://${neverHost}/`);
    expect(run.site.loaded).toBe(false);
    expect(run.product!.launch.signal).toBe('fail');
    expect(run.product!.flow.signal).toBe('fail');
    expect(rows.some(r => r.status === 'fail' && /didn't load/.test(r.text))).toBe(true);
  });
});

describe('browser agent driven by the model (scripted SDK client)', () => {
  it('executes validated tool calls, refuses links that are not on the page, and stops on done', async () => {
    const calls: { name: string; input: unknown }[] = [
      { name: 'open_link', input: { url: 'http://169.254.169.254/latest/meta-data/' } },
      { name: 'click', input: { text: 'Launch app' } },
      { name: 'click', input: { text: 'Connect wallet' } },
      { name: 'done', input: { reason: 'Wallet connected; stopping before the swap' } },
    ];
    let n = 0;
    const seen: string[] = [];
    const client: AnthropicClientLike = {
      messages: {
        parse: async () => { throw new Error('not used'); },
        create: async p => {
          const last = p.messages[p.messages.length - 1];
          seen.push(JSON.stringify(last.content).slice(0, 20000));
          const c = calls[n++];
          return { id: `m${n}`, type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null,
            usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
            content: [{ type: 'tool_use', id: `tu_${n}`, name: c.name, input: c.input, caller: { type: 'direct' } } as Anthropic.ToolUseBlock] } as Anthropic.Message;
        },
      },
    };
    const ai = new ResilientAi(new AnthropicAi(testEnv({ ANTHROPIC_API_KEY: 'k' }), { client }));
    const { run, rows } = await browse(sites.get('working-app')!.url, ai);
    expect(rows.some(r => r.text === 'Skipped a link that is not on the page')).toBe(true);
    expect(rows.some(r => r.text === "'Connect wallet' asked the test wallet to connect")).toBe(true);
    expect(run.explorer!.result.doneReason).toBe('Wallet connected; stopping before the swap');
    expect(run.product!.launch.signal).toBe('ok');
    expect(run.product!.flow.signal).toBe('warn');
    expect(run.aiFallbacks.size).toBe(0);
    // the model saw each result and a screenshot inside the tool_result
    expect(seen[2]).toMatch(/tool_result[\s\S]*opens working-app\.test[\s\S]*"type":"image"/);
  });
});
