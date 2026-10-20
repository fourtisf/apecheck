/**
 * MCP server (M4, Max; HANDOFF §9 and the /api page): Streamable HTTP at `POST /mcp`, which mcp.apecheck.io proxies
 * to. Stateless: every POST gets a fresh McpServer + StreamableHTTPServerTransport (no session id), the response is
 * an SSE stream (keep-alive comments every 15 s while a tool runs); `GET` and `DELETE /mcp` answer 405. Off when
 * MCP_ENABLED is false (404).
 *
 * Auth: the same Bearer API key as the REST routes (plugins/apiKeys.ts: per-key rate limit, Max only, lastUsedAt).
 * No key → 401 key_required; a bad or revoked key → 401 invalid_key; not Max → 403 max_required (plain HTTP errors,
 * before any MCP message is read).
 *
 * Tools (failures are MCP tool errors, `isError: true` with the reason as text, never HTTP 500s):
 *  - run_check(target): starts a check as POST /v1/checks does with the key (via API, one of the owner's
 *    MAX_CHECKS_PER_DAY, same-target reuse and cache) and waits up to 150 s for it to finish →
 *    { id, status: "done", target, narrative, coin, total, verdict, summary, report_url } (the webhook payload's
 *    `check`), or { id, status: "running", report_url } when it takes longer. Sends notifications/progress with the
 *    live log when the client asked for progress (`_meta.progressToken`).
 *  - get_check(id): the full report JSON (GET /v1/checks/:id as the key's owner).
 *  - ask_followup(id, question): a follow-up answered from the check's record (POST /v1/checks/:id/asks rules).
 *  - deployer_history(wallet): what is known about the wallet as a deployer (DevRadar record) and the coins of it
 *    that were checked.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FOOTER_DISCLAIMER,
  checkChannel,
  chainFromDb,
  deployerLine,
  recordFromDb,
  type CheckReportDTO,
  type DeployerDTO,
} from '@apecheck/core';
import type { Prisma } from '@apecheck/db';
import { creditSubject } from './accounts';
import { createCheck, loadReport } from './checks';
import type { AppDeps } from './context';
import { ApiError, MSG } from './errors';
import { SHORT_ID_RE } from './ids';
import { coinVerdictOf, narrativeOf, toCheckResult, toDeployerDTO, type CheckResult, type Viewer } from './mappers';
import { askOnCheck } from './routes/community';
import { publicDeployerWhere } from './routes/insights';
import { viewerOf } from './routes/util';

/** how long run_check waits for the check to finish */
export const MCP_RUN_WAIT_MS = 150_000;
/** run_check also polls the database this often (the "done" message is the fast path) */
const RUN_POLL_MS = 3_000;
const COINS_MAX = 50;

export const MCP_TOOLS = ['run_check', 'get_check', 'ask_followup', 'deployer_history'] as const;

const INSTRUCTIONS = [
  'ApeCheck checks whether a crypto project is real: an agent opens the site, tests what it claims, reads the X account,',
  'the contract, the holders and the deployer history, and scores the narrative and the coin (0-100).',
  'run_check starts a check (one of your daily checks; a recent check of the same project is returned free) and waits up',
  'to 150 seconds. If it is still running, call get_check with its id a minute later. ask_followup answers questions',
  'about a finished check from its record. deployer_history shows what a wallet launched before.',
  FOOTER_DISCLAIMER,
].join(' ');

/**
 * Open MCP requests of this server. At shutdown their waits end (the tools answer at once), and a response that
 * completes then also ends its keep-alive connection: server.close() would otherwise wait for the client to drop it.
 */
export class McpRegistry {
  private readonly open = new Set<AbortController>();
  private closing = false;
  start(): AbortController {
    const c = new AbortController();
    if (this.closing) c.abort();
    this.open.add(c);
    return c;
  }
  finish(c: AbortController, socket?: { end(): void } | null) {
    this.open.delete(c);
    if (this.closing) socket?.end();
  }
  abortAll() {
    this.closing = true;
    for (const c of [...this.open]) c.abort();
  }
}

/* ---------------- tool results ---------------- */

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const toolError = (message: string, data?: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  ...(data ? { structuredContent: data } : {}),
});

/** Run a tool body: ApiErrors become tool errors with their message, anything else a generic one (logged). */
async function guarded(request: FastifyRequest, tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return toolError(err.message, { code: err.code });
    request.log.error({ err, tool }, 'mcp tool failed');
    return toolError(MSG.internal, { code: 'internal' });
  }
}

/* ---------------- run_check ---------------- */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

type Progress = (progress: number, message: string) => void;

/**
 * Wait until the check (internal id) is DONE or FAILED, at most `ms`: the worker's "done" message on check:{id} ends
 * the wait at once, a status poll every RUN_POLL_MS covers a missed message. Returns the final status, or null.
 */
async function waitForCheck(deps: AppDeps, checkId: string, ms: number, signal: AbortSignal, onProgress?: Progress): Promise<'DONE' | 'FAILED' | null> {
  let wake: () => void = () => undefined;
  let finished = false;
  const unsubscribe = await deps.hub.subscribe(checkChannel(checkId), raw => {
    let msg: { type?: string; progress?: unknown; step?: { text?: unknown } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'done') {
      finished = true;
      wake();
    } else if (msg.type === 'step' && onProgress && typeof msg.step?.text === 'string') {
      const p = typeof msg.progress === 'number' && Number.isFinite(msg.progress) ? Math.min(1, Math.max(0, msg.progress)) : 0;
      onProgress(p, msg.step.text);
    }
  });
  try {
    const deadline = Date.now() + ms;
    for (;;) {
      const row = await deps.prisma.check.findUnique({ where: { id: checkId }, select: { status: true } });
      if (!row) return null;
      if (row.status === 'DONE' || row.status === 'FAILED') return row.status;
      const left = deadline - Date.now();
      if (left <= 0 || signal.aborted) return null;
      // "done" arrived but the row doesn't say so yet: look again shortly
      if (finished) {
        await sleep(Math.min(250, left), signal);
        continue;
      }
      const nap = new AbortController();
      const stop = () => nap.abort();
      signal.addEventListener('abort', stop, { once: true });
      wake = stop;
      await sleep(Math.min(RUN_POLL_MS, left), nap.signal);
      signal.removeEventListener('abort', stop);
      wake = () => undefined;
    }
  } finally {
    await unsubscribe().catch(() => undefined);
  }
}

const resultSelect = {
  id: true,
  shortId: true,
  status: true,
  error: true,
  targetRaw: true,
  narScore: true,
  narBand: true,
  coinScore: true,
  coinBand: true,
  totalScore: true,
  summary: true,
} satisfies Prisma.CheckSelect;

async function runCheck(deps: AppDeps, request: FastifyRequest, target: string, signal: AbortSignal, onProgress?: Progress): Promise<CallToolResult> {
  // the key's owner is Max (plugins/apiKeys.ts): their credits, their priority, via API
  const created = await createCheck(deps, { target, via: 'API' }, creditSubject(request, 'max'), request.log);
  const shortId = created.body.id;
  const reportUrl = `${deps.env.APP_URL.replace(/\/+$/, '')}/c/${shortId}`;
  let row = await deps.prisma.check.findUnique({ where: { shortId }, select: resultSelect });
  if (!row) throw new ApiError(404, 'not_found', MSG.notFound);
  if (row.status !== 'DONE' && row.status !== 'FAILED') {
    const status = await waitForCheck(deps, row.id, deps.mcpWaitMs ?? MCP_RUN_WAIT_MS, signal, onProgress);
    if (!status) {
      return ok({
        id: shortId,
        status: 'running',
        report_url: reportUrl,
        message: 'The check is still running. Call get_check with this id in a minute.',
      });
    }
    row = await deps.prisma.check.findUnique({ where: { id: row.id }, select: resultSelect });
    if (!row) throw new ApiError(404, 'not_found', MSG.notFound);
  }
  if (row.status === 'FAILED') {
    const reason = row.error ? row.error.replace(/\s*\([\s\S]*$/, '').slice(0, 200) : "The check couldn't finish.";
    return toolError(`${reason} Report: ${reportUrl}`, { id: shortId, status: 'failed', error: reason, report_url: reportUrl });
  }
  const { id, ...rest }: CheckResult = toCheckResult(row, deps.env);
  return ok({ id, status: 'done', ...rest });
}

/* ---------------- deployer_history ---------------- */

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** EVM, Solana (base58) and Tron addresses are all plain alphanumeric strings of this length */
const WALLET_RE = /^[A-Za-z0-9]{20,64}$/;

export interface DeployerHistory {
  wallet: string;
  /** anything is known about the wallet */
  known: boolean;
  /** the DevRadar record per chain (an EVM wallet can deploy on several) */
  deployers: (DeployerDTO & { recordText: string })[];
  /** the checked coins it deployed: each coin's latest check the viewer can see, newest first */
  coins: {
    id: string;
    name: string;
    ticker: string | null;
    chain: string | null;
    ca: string | null;
    coinScore: number | null;
    coinVerdict: string | null;
    narrative: number | null;
    verdict: string | null;
    total: number | null;
    checkedAt: string | null;
    report_url: string;
  }[];
}

/**
 * A wallet's deployer record and its checked coins, as far as the viewer may see them: deployers listed on
 * /deployers (publicDeployerWhere) or named by the viewer's own private checks; coins from public verdicts or the
 * viewer's own private checks.
 */
export async function deployerHistory(deps: Pick<AppDeps, 'prisma' | 'env'>, wallet: string, viewer: Viewer): Promise<DeployerHistory> {
  const { prisma, env } = deps;
  const address: Prisma.StringFilter = EVM_RE.test(wallet) ? { equals: wallet, mode: 'insensitive' } : { equals: wallet };
  const own: Prisma.CheckWhereInput | null = viewer.userId ? { isPrivate: true, requesterId: viewer.userId } : null;
  const visible: Prisma.CheckWhereInput = own ? { OR: [{ isPrivate: false }, own] } : { isPrivate: false };

  const deployers = await prisma.deployer.findMany({
    where: { AND: [{ address }, own ? { OR: [publicDeployerWhere, { coins: { some: { check: { status: 'DONE', ...own } } } }] } : publicDeployerWhere] },
    orderBy: [{ launched: 'desc' }, { id: 'asc' }],
  });
  const checks = await prisma.check.findMany({
    where: {
      AND: [
        { status: 'DONE' },
        visible,
        { coinFacts: { is: { OR: [{ deployerAddress: address }, ...(deployers.length ? [{ deployerId: { in: deployers.map(d => d.id) } }] : [])] } } },
      ],
    },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    take: 500,
    select: {
      shortId: true,
      targetId: true,
      narScore: true,
      narBand: true,
      coinScore: true,
      coinBand: true,
      totalScore: true,
      finishedAt: true,
      target: { select: { name: true, ticker: true, chain: true, ca: true } },
    },
  });
  const seen = new Set<string>();
  const coins: DeployerHistory['coins'] = [];
  const appUrl = env.APP_URL.replace(/\/+$/, '');
  for (const c of checks) {
    if (seen.has(c.targetId)) continue;
    seen.add(c.targetId);
    coins.push({
      id: c.shortId,
      name: c.target.name,
      ticker: c.target.ticker,
      chain: chainFromDb(c.target.chain),
      ca: c.target.ca,
      coinScore: c.coinScore,
      coinVerdict: coinVerdictOf(c.coinScore, c.coinBand),
      narrative: c.narScore,
      verdict: narrativeOf(c.narScore, c.narBand)?.verdict ?? null,
      total: c.totalScore,
      checkedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
      report_url: `${appUrl}/c/${c.shortId}`,
    });
    if (coins.length >= COINS_MAX) break;
  }
  return {
    wallet,
    known: deployers.length > 0 || coins.length > 0,
    deployers: deployers.map(d => ({
      ...toDeployerDTO(d),
      recordText: deployerLine({ record: recordFromDb(d.record), launched: d.launched, dead: d.dead, fundedFrom: d.fundedFrom }),
    })),
    coins,
  };
}

/* ---------------- the server ---------------- */

/** One McpServer for one HTTP request, acting as the key's owner. */
export function buildMcpServer(deps: AppDeps, request: FastifyRequest, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'apecheck', title: 'ApeCheck', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const viewer = (): Viewer => viewerOf(request);

  server.registerTool(
    'run_check',
    {
      title: 'Run a check',
      description:
        'Check a crypto project: paste a contract address, an X post link or a website. Waits up to 150 seconds and returns ' +
        'the narrative and coin scores (0-100), the total, the verdict, a one-line summary and the report link. Uses one of ' +
        'your daily checks unless the project was checked in the last few hours.',
      inputSchema: { target: z.string().trim().min(1).max(2048).describe('Contract address, X post link or website, e.g. "orbitswap.xyz"') },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ target }, extra) =>
      guarded(request, 'run_check', () => {
        const token = extra._meta?.progressToken;
        const both = AbortSignal.any([signal, extra.signal]);
        const onProgress: Progress | undefined =
          token != null
            ? (progress, message) => {
                void extra
                  .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(progress * 100), total: 100, message } })
                  .catch(() => undefined);
              }
            : undefined;
        return runCheck(deps, request, target, both, onProgress);
      }),
  );

  server.registerTool(
    'get_check',
    {
      title: 'Get a check report',
      description: 'The full report of a check by its id (from run_check or a report link apecheck.io/c/<id>): scores, claims and what was seen, coin facts, the live log, follow-ups and notes.',
      inputSchema: { id: z.string().trim().min(1).max(64).describe('Check id, e.g. "8f2a91x"') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guarded(request, 'get_check', async () => {
        const shortId = id.replace(/^.*\/c\//, '');
        const report: CheckReportDTO | null = SHORT_ID_RE.test(shortId) ? await loadReport(deps, { shortId }, viewer()) : null;
        if (!report) return toolError(MSG.notFound, { code: 'not_found' });
        return ok(report as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    'ask_followup',
    {
      title: 'Ask a follow-up',
      description: 'Ask a question about a finished check, answered from what the check recorded (e.g. "who funded the deployer?"). 3 to 280 characters.',
      inputSchema: {
        id: z.string().trim().min(1).max(64).describe('Check id'),
        question: z.string().max(1000).describe('The question, 3 to 280 characters'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, question }) =>
      guarded(request, 'ask_followup', async () => {
        const { ask } = await askOnCheck(deps, request, id.replace(/^.*\/c\//, ''), question);
        return ok({ check: id, ...ask });
      }),
  );

  server.registerTool(
    'deployer_history',
    {
      title: 'Deployer history',
      description: "What a wallet launched before: its deployer record (builder, mixed record or serial launcher) and the coins of it that were checked, with their scores.",
      inputSchema: { wallet: z.string().trim().min(20).max(64).describe('Deployer wallet address (EVM 0x…, Solana or Tron)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ wallet }) =>
      guarded(request, 'deployer_history', async () => {
        if (!WALLET_RE.test(wallet)) return toolError("That doesn't look like a wallet address.", { code: 'bad_request' });
        return ok((await deployerHistory(deps, wallet, viewer())) as unknown as Record<string, unknown>);
      }),
  );

  return server;
}

function notAllowed(_request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(405)
    .header('Allow', 'POST')
    .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
}

export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps, registry: McpRegistry) {
  if (!deps.env.MCP_ENABLED) return;

  app.post('/mcp', async (request, reply) => {
    if (!request.viewer.apiKeyId) {
      reply.header('WWW-Authenticate', 'Bearer realm="apecheck"');
      throw new ApiError(401, 'key_required', MSG.keyRequired);
    }
    // headers set by hooks (CORS, rate limits) are carried over: a hijacked reply skips Fastify's send path
    const carried = Object.entries(reply.getHeaders()).filter(([, v]) => v != null) as [string, string | number | string[]][];
    reply.hijack();
    for (const [k, v] of carried) reply.raw.setHeader(k, v);
    request.raw.socket?.setTimeout?.(0);

    const ctrl = registry.start();
    const server = buildMcpServer(deps, request, ctrl.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      ctrl.abort();
      registry.finish(ctrl, request.raw.socket);
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  // stateless: no standalone SSE stream to open (GET) and no session to end (DELETE)
  app.get('/mcp', { exposeHeadRoute: false }, notAllowed);
  app.delete('/mcp', notAllowed);
}
