/**
 * M4 MCP server: a real MCP client (StreamableHTTPClientTransport) against the API listening on 127.0.0.1, with a
 * tiny in-test checks worker (marks the check DONE or FAILED and publishes "done") and asks worker.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  QUEUES,
  checkChannel,
  creditsKeyUser,
  type AskJob,
  type AskJobResult,
  type CheckJob,
  type CheckReportDTO,
  type CreateApiKeyResponse,
} from '@apecheck/core';
import { TEST_REDIS_URL } from './global-setup';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedCoinFacts, seedDeployer, seedTarget, signedIn, type Harness } from './helpers';

const maxW = new EvmWallet();
const max2W = new SolWallet();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

async function listen(h: Harness): Promise<string> {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

async function connect(base: string, key?: string): Promise<McpClient> {
  const client = new McpClient({ name: 'apecheck-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
  });
  await client.connect(transport);
  return client;
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
const rawPost = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  });

describe('MCP server', () => {
  let h: Harness;
  let base: string;
  let key: string;
  let userId: string;
  let checksWorker: Worker<CheckJob> | null = null;
  let asksWorker: Worker<AskJob, AskJobResult> | null = null;
  const conns: Redis[] = [];
  let checkMode: 'done' | 'fail' | 'hang' = 'done';
  const clients: McpClient[] = [];

  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max,${max2W.address}:max` }, { mcpWaitMs: 2000, askWaitMs: 5000 });
    base = await listen(h);
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await resetState(h);
    checkMode = 'done';
    const c = new Client(h.app);
    userId = (await signedIn(c, maxW)).user!.id;
    key = (await c.post('/v1/keys', { name: 'mcp' })).json<CreateApiKeyResponse>().key;

    const cConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const aConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    conns.push(cConn, aConn);
    checksWorker = new Worker<CheckJob>(
      QUEUES.checks,
      async (job: Job<CheckJob>) => {
        if (checkMode === 'hang') return;
        const id = job.data.checkId;
        await h.prisma.check.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date() } });
        // late enough for run_check to be listening
        await sleep(300);
        await h.publisher.publish(checkChannel(id), JSON.stringify({ type: 'step', step: { idx: 0, t: 10, status: 'info', text: 'Opening the site' }, progress: 0.5 }));
        await sleep(50);
        if (checkMode === 'fail') {
          await h.prisma.check.update({ where: { id }, data: { status: 'FAILED', finishedAt: new Date(), error: "The site didn't load. (net::ERR_TIMED_OUT at https://x)" } });
          await h.publisher.publish(checkChannel(id), JSON.stringify({ type: 'done', status: 'failed' }));
          return;
        }
        await h.prisma.check.update({
          where: { id },
          data: {
            status: 'DONE',
            finishedAt: new Date(),
            isLatest: true,
            narScore: 48,
            narBand: 'partly',
            coinScore: 44,
            coinBand: 'sketchy',
            totalScore: 46,
            summary: "The app loads but the main flow stops at 'Coming soon'.",
          },
        });
        await h.publisher.publish(checkChannel(id), JSON.stringify({ type: 'done', status: 'done' }));
      },
      { connection: cConn, concurrency: 4 },
    );
    asksWorker = new Worker<AskJob, AskJobResult>(
      QUEUES.asks,
      async job => {
        const ask = await h.prisma.ask.create({
          data: { checkId: job.data.checkId, question: job.data.question, answer: `Answer to: ${job.data.question}`, askerId: job.data.userId, via: 'WEB' },
        });
        await h.prisma.check.update({ where: { id: job.data.checkId }, data: { asksCount: { increment: 1 } } });
        return { askId: ask.id };
      },
      { connection: aConn, concurrency: 2 },
    );
    await Promise.all([checksWorker.waitUntilReady(), asksWorker.waitUntilReady()]);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await checksWorker?.close();
    await asksWorker?.close();
    for (const c of conns.splice(0)) await c.quit();
  });

  async function mcp(k = key) {
    const c = await connect(base, k);
    clients.push(c);
    return c;
  }
  const call = async (c: McpClient, name: string, args: Record<string, unknown>, opts = {}) => (await c.callTool({ name, arguments: args }, undefined, opts)) as ToolResult;

  it('lists the four tools', async () => {
    const c = await mcp();
    expect(c.getServerVersion()).toMatchObject({ name: 'apecheck' });
    expect(c.getInstructions()).toContain('run_check');
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['ask_followup', 'deployer_history', 'get_check', 'run_check']);
    const run = tools.find(t => t.name === 'run_check')!;
    expect(run.inputSchema).toMatchObject({ type: 'object', properties: { target: { type: 'string' } }, required: ['target'] });
    expect(tools.find(t => t.name === 'ask_followup')!.inputSchema.required?.sort()).toEqual(['id', 'question']);
  });

  it('run_check starts a check through the key, waits for it and returns the verdict', async () => {
    const c = await mcp();
    const progress: { progress: number; message?: string }[] = [];
    const res = await call(c, 'run_check', { target: 'orbitswap.xyz' }, { onprogress: (p: { progress: number; message?: string }) => progress.push(p) });
    expect(res.isError).toBeFalsy();
    const check = await h.prisma.check.findFirstOrThrow({ where: { targetRaw: 'orbitswap.xyz' } });
    const expected = {
      id: check.shortId,
      status: 'done',
      target: 'orbitswap.xyz',
      narrative: 48,
      coin: 44,
      total: 46,
      verdict: 'PARTLY_REAL',
      summary: "The app loads but the main flow stops at 'Coming soon'.",
      report_url: `http://app.test/c/${check.shortId}`,
    };
    expect(res.structuredContent).toEqual(expected);
    expect(JSON.parse(res.content[0].text!)).toEqual(expected);
    // via API, for the key's owner, charged to their daily Max credits
    expect(check).toMatchObject({ via: 'API', requesterId: userId, isPrivate: false });
    expect(await h.redis.get(creditsKeyUser(userId))).toBe('1');
    // the live log as progress notifications
    expect(progress).toEqual([{ progress: 50, total: 100, message: 'Opening the site' }]);

    // the same project again: the fresh verdict, free
    const again = await call(c, 'run_check', { target: 'https://orbitswap.xyz/' });
    expect(again.structuredContent).toMatchObject({ id: check.shortId, status: 'done' });
    expect(await h.redis.get(creditsKeyUser(userId))).toBe('1');
  });

  it('run_check returns { status: "running" } when the check takes longer than the wait', async () => {
    checkMode = 'hang';
    const c = await mcp();
    const t0 = Date.now();
    const res = await call(c, 'run_check', { target: 'slowproject.xyz' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    const check = await h.prisma.check.findFirstOrThrow({ where: { targetRaw: 'slowproject.xyz' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      id: check.shortId,
      status: 'running',
      report_url: `http://app.test/c/${check.shortId}`,
      message: 'The check is still running. Call get_check with this id in a minute.',
    });
  });

  it('run_check reports a failed check and a bad target as tool errors, not HTTP errors', async () => {
    const c = await mcp();
    const bad = await call(c, 'run_check', { target: 'hello there' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('Paste a contract address, an X post link or a website');
    expect(bad.structuredContent).toEqual({ code: 'bad_target' });

    checkMode = 'fail';
    const failed = await call(c, 'run_check', { target: 'deadsite.xyz' });
    const check = await h.prisma.check.findFirstOrThrow({ where: { targetRaw: 'deadsite.xyz' } });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(`The site didn't load. Report: http://app.test/c/${check.shortId}`);
    expect(failed.structuredContent).toMatchObject({ id: check.shortId, status: 'failed', error: "The site didn't load." });
  });

  it('run_check with no daily checks left is a tool error', async () => {
    await h.redis.set(creditsKeyUser(userId), '200');
    const c = await mcp();
    const res = await call(c, 'run_check', { target: 'nocredits.xyz' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({ code: 'no_credits' });
  });

  it('get_check returns the full report (by id or report link); unknown and private ones are tool errors', async () => {
    const t = await seedTarget(h.prisma);
    const done = await seedCheck(h.prisma, { targetId: t.id, narScore: 82, narBand: 'real', totalScore: 82, summary: 'Works as described.' });
    const c = await mcp();
    const res = await call(c, 'get_check', { id: done.shortId });
    expect(res.isError).toBeFalsy();
    const report = res.structuredContent as unknown as CheckReportDTO;
    expect(report).toMatchObject({ id: done.shortId, narrative: { verdict: 'REAL', score: 82 }, report_url: `http://app.test/c/${done.shortId}`, summary: 'Works as described.' });
    expect(Array.isArray(report.claims)).toBe(true);
    expect((await call(c, 'get_check', { id: `https://apecheck.io/c/${done.shortId}` })).structuredContent).toMatchObject({ id: done.shortId });

    const missing = await call(c, 'get_check', { id: 'zzzzzzz' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe("This check doesn't exist or has expired.");
    const priv = await seedCheck(h.prisma, { targetId: t.id, isPrivate: true, requesterId: (await h.prisma.user.create({ data: {} })).id });
    expect((await call(c, 'get_check', { id: priv.shortId })).isError).toBe(true);
  });

  it('ask_followup answers through the asks queue; the same rules as POST asks', async () => {
    const t = await seedTarget(h.prisma);
    const done = await seedCheck(h.prisma, { targetId: t.id });
    const c = await mcp();
    const res = await call(c, 'ask_followup', { id: done.shortId, question: '  Who funded   the deployer? ' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ check: done.shortId, question: 'Who funded the deployer?', answer: 'Answer to: Who funded the deployer?', via: 'site' });
    expect(await h.prisma.ask.count({ where: { checkId: done.id, askerId: userId } })).toBe(1);

    const short = await call(c, 'ask_followup', { id: done.shortId, question: 'hi' });
    expect(short).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Ask a question of 3 to 280 characters.' }] });
    const running = await seedCheck(h.prisma, { targetId: t.id, status: 'RUNNING' });
    const notReady = await call(c, 'ask_followup', { id: running.shortId, question: 'is it live?' });
    expect(notReady).toMatchObject({ isError: true, structuredContent: { code: 'not_ready' } });
  });

  it("deployer_history returns the wallet's record and its checked coins, never another user's private checks", async () => {
    const dep = await seedDeployer(h.prisma, { chain: 'SOL', record: 'MIXED', launched: 6, dead: 2, fundedFrom: 'Binance hot wallet' });
    const coinT = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: 'MintOne1111111111111111111111111111111111111', ticker: 'ONE', name: '$ONE', domain: null, key: 'ca:sol:one' });
    const pub = await seedCheck(h.prisma, { targetId: coinT.id, coinScore: 44, coinBand: 'sketchy', narScore: 30, narBand: 'llarp', totalScore: 37 });
    await seedCoinFacts(h.prisma, pub.id, { deployerId: dep.id, deployerAddress: dep.address });
    // someone else's private check of another coin by the same wallet stays hidden
    const hiddenT = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: 'MintTwo2222222222222222222222222222222222222', ticker: 'TWO', name: '$TWO', domain: null, key: 'ca:sol:two' });
    const stranger = await h.prisma.user.create({ data: {} });
    const hidden = await seedCheck(h.prisma, { targetId: hiddenT.id, isPrivate: true, isLatest: false, requesterId: stranger.id, coinScore: 10, coinBand: 'rigged' });
    await seedCoinFacts(h.prisma, hidden.id, { deployerId: dep.id, deployerAddress: dep.address });

    const c = await mcp();
    const res = await call(c, 'deployer_history', { wallet: dep.address });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      wallet: dep.address,
      known: true,
      deployers: [
        {
          id: dep.id,
          chain: 'sol',
          address: dep.address,
          record: 'mixed',
          launched: 6,
          dead: 2,
          fundedFrom: 'Binance hot wallet',
          firstSeen: null,
          recordText: '6 earlier tokens, 2 dead',
        },
      ],
      coins: [
        {
          id: pub.shortId,
          name: '$ONE',
          ticker: 'ONE',
          chain: 'sol',
          ca: 'MintOne1111111111111111111111111111111111111',
          coinScore: 44,
          coinVerdict: 'SKETCHY',
          narrative: 30,
          verdict: 'LIKELY_LARP',
          total: 37,
          checkedAt: expect.any(String),
          report_url: `http://app.test/c/${pub.shortId}`,
        },
      ],
    });

    // an EVM wallet matches whatever its case; an unknown one is simply not known
    const evmDep = await seedDeployer(h.prisma, { chain: 'BASE', address: '0xabcdef0123456789abcdef0123456789abcdef01', record: 'BUILDER', launched: 1 });
    const evm = await call(c, 'deployer_history', { wallet: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01' });
    expect(evm.structuredContent).toMatchObject({ known: true, deployers: [{ id: evmDep.id, chain: 'base', recordText: 'first launch' }], coins: [] });
    const unknown = await call(c, 'deployer_history', { wallet: '0x1111111111111111111111111111111111111111' });
    expect(unknown.structuredContent).toEqual({ wallet: '0x1111111111111111111111111111111111111111', known: false, deployers: [], coins: [] });
    const bad = await call(c, 'deployer_history', { wallet: 'not-a-wallet-address-at-all!!!' });
    expect(bad).toMatchObject({ isError: true, content: [{ text: "That doesn't look like a wallet address." }] });
  });

  it('auth: no key 401 key_required, bad or revoked key 401 invalid_key, non-Max 403; the client cannot connect', async () => {
    const noKey = await rawPost(base, {});
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toEqual({ code: 'key_required', error: 'Add your ApeCheck API key: "Authorization: Bearer ak_live_…". Create one on apecheck.io/api.' });
    expect(noKey.headers.get('www-authenticate')).toMatch(/^Bearer /);

    const bad = await rawPost(base, { authorization: `Bearer ak_live_${'x'.repeat(32)}` });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_key');

    const free = new Client(h.app);
    const freeMe = await signedIn(free, new EvmWallet());
    const plain = 'ak_live_' + 'M'.repeat(32);
    await h.prisma.apiKey.create({ data: { userId: freeMe.user!.id, prefix: plain.slice(0, 12), hash: sha256(plain) } });
    const notMax = await rawPost(base, { authorization: `Bearer ${plain}` });
    expect(notMax.status).toBe(403);
    expect(((await notMax.json()) as { code: string }).code).toBe('max_required');

    // a signed-in session is not enough: MCP takes keys only
    const session = new Client(h.app);
    await signedIn(session, max2W);
    const viaCookie = await rawPost(base, { cookie: session.cookie! });
    expect(viaCookie.status).toBe(401);

    await expect(connect(base)).rejects.toThrow();
    await expect(connect(base, `ak_live_${'y'.repeat(32)}`)).rejects.toThrow();

    // revoking the key ends access
    const ok = await rawPost(base, { authorization: `Bearer ${key}` });
    expect(ok.status).toBe(200);
    await h.prisma.apiKey.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
    expect((await rawPost(base, { authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it('stateless: GET and DELETE answer 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' } });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    }
  });
});

describe('MCP server lifecycle', () => {
  it('MCP_ENABLED=false: no /mcp', async () => {
    const h = await makeHarness({ MCP_ENABLED: 'false' });
    try {
      const res = await h.app.inject({ method: 'POST', url: '/mcp', payload: initialize });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('a waiting run_check answers "running" at shutdown instead of holding the server open', async () => {
    const h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max` }, { mcpWaitMs: 60_000 });
    let closed = false;
    try {
      await resetState(h);
      const base = await listen(h);
      const c = new Client(h.app);
      await signedIn(c, maxW);
      const key = (await c.post('/v1/keys', {})).json<CreateApiKeyResponse>().key;
      const client = await connect(base, key);
      // no checks worker: the check stays queued
      const pending = client.callTool({ name: 'run_check', arguments: { target: 'shutdown-test.xyz' } }) as Promise<ToolResult>;
      await sleep(500);
      const t0 = Date.now();
      const closing = h.close().then(() => (closed = true));
      const res = await pending;
      expect(res.structuredContent).toMatchObject({ status: 'running' });
      await closing;
      // the tool answered and the keep-alive connection was let go: no wait for the client to drop it
      expect(Date.now() - t0).toBeLessThan(2000);
      await client.close().catch(() => undefined);
    } finally {
      if (!closed) await h.close();
    }
  });
});
