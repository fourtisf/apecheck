/**
 * Stage B on every fixture site with the heuristic agent, in real Chromium behind the real SSRF guard
 * proxy: expected launch / flow / docs signals and one screenshot per browser step.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicAi, ResilientAi, type AnthropicClientLike } from '../src/ai';
import { BrowserHost } from '../src/browser/browser';
import { browseStage } from '../src/pipeline/browse';
import { closedPort, serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { fakeSources } from './fakes';
import { standaloneRun, testEnv } from './helpers';

const NAMES = ['working-app', 'waitlist', 'dead-button', 'coming-soon-flow', 'broken-docs', 'noisy-dead', 'picker-app'] as const;
const sites = new Map<string, FixtureSite>();
let host: BrowserHost;
let neverHost: string;
let env: ReturnType<typeof testEnv>;

beforeAll(async () => {
  for (const n of NAMES) sites.set(n, await serveFixture(n));
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
