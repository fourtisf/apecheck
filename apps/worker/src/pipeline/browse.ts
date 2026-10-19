/**
 * Stage B — browse. Open the site in a fresh guarded context, read it, let the agent try the main flow
 * (bounded: CHECK_MAX_AGENT_ACTIONS actions, 60 s), then measure the docs. Product signals are computed
 * from whatever was observed, even when part of the stage timed out.
 */
import { CHAINS, normalizeDomain, type ChainKey } from '@apecheck/core';
import { Explorer, type SimOutcome } from '../browser/agent';
import { COMING_SOON_RE, CONNECT_RE, NEEDS_FUNDS_RE, SIM_INFRA_RE, WAITLIST_RE, isAppUrl, launchRank, AUDIT_RE } from '../browser/keywords';
import { chainFromHex, evmChainIdHex, type CapturedTx } from '../browser/mock-wallet';
import { crawlDocs, findDocsLink } from '../browser/docs';
import { domSummary, openSite, pageText, probe, screenshot } from '../browser/page';
import type { CheckRun } from './context';
import { runStage, within, type StageCtx } from './stage';
import { docsSignal, productSignals } from './signals';
import { secs } from './text';

const LIVE_RE = /\b(live (now|on)|now live|is live|launch app|open app|use the app|try it|available now|mainnet|trade now|start trading)\b/i;

function readRpcFor(run: CheckRun) {
  const env = run.env as unknown as Record<string, string | undefined>;
  return async (chainIdHex: string, method: string, params: unknown[]) => {
    const chain = chainFromHex(chainIdHex);
    const url = chain ? env[CHAINS[chain].rpcEnv] : undefined;
    if (!url) throw new Error('no RPC for this chain');
    const res = await run.sources.http.json<{ result?: unknown; error?: { message?: string } }>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      timeoutMs: 8000,
      maxBytes: 2_000_000,
    });
    if (res.error) throw new Error(res.error.message ?? 'RPC error');
    return res.result ?? null;
  };
}

export function classifySim(r: { ok: boolean; error?: string | null }, chain: ChainKey | null): SimOutcome {
  if (r.ok) return { status: 'ok', detail: null, needsFunds: false, chain };
  const raw = (r.error ?? 'reverted').replace(/\s+/g, ' ').trim();
  // the EVM adapter prefixes transport failures (no node answer) with "simulation failed:"; a node's revert has no prefix
  const transport = /^simulation (failed|unavailable):/i.test(raw);
  const detail = raw.replace(/^simulation (failed|unavailable):\s*/i, '').slice(0, 120);
  if (transport || SIM_INFRA_RE.test(detail)) return { status: 'skipped', detail, needsFunds: false, chain };
  return { status: 'fail', detail, needsFunds: NEEDS_FUNDS_RE.test(detail), chain };
}

function simulator(run: CheckRun) {
  return async (tx: CapturedTx): Promise<SimOutcome> => {
    const { evm, sol } = run.sources;
    if (tx.kind === 'evm') {
      const chain = chainFromHex(tx.chainId) ?? (run.chain && CHAINS[run.chain].family === 'evm' ? run.chain : 'eth');
      if (!tx.evm) return { status: 'skipped', detail: 'no transaction payload', needsFunds: false, chain };
      const r = await within(evm.simulate(chain, tx.evm), 15_000, { ok: false, error: 'simulation timed out' });
      return classifySim(r, chain);
    }
    if (!tx.base64) return { status: 'skipped', detail: 'transaction could not be serialised', needsFunds: false, chain: 'sol' };
    const r = await within(sol.simulate(tx.base64), 15_000, { ok: false, error: 'simulation timed out' });
    return classifySim(r, 'sol');
  };
}

function collectLinks(run: CheckRun, links: { href: string; text: string }[]) {
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'github.com' && /^\/[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?\/?$/.test(u.pathname) && run.links.github.length < 8) {
      const clean = `https://github.com${u.pathname.replace(/\/+$/, '')}`;
      if (!run.links.github.includes(clean)) run.links.github.push(clean);
    } else if ((host === 't.me' || host === 'telegram.me') && !run.links.telegram) run.links.telegram = u.href;
    else if ((host === 'discord.gg' || host === 'discord.com') && !run.links.discord) run.links.discord = u.href;
    else if ((host === 'x.com' || host === 'twitter.com') && !run.handle) {
      const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(u.pathname);
      if (m && !['intent', 'share', 'home', 'i', 'search', 'hashtag'].includes(m[1].toLowerCase())) {
        run.handle = m[1];
        run.links.x = `https://x.com/${m[1]}`;
      }
    }
    if (!run.auditLink && (AUDIT_RE.test(l.text) || /audit/i.test(u.pathname)) && l.text.length <= 60) run.auditLink = { url: u.href, stepIdx: null };
  }
}

export async function browseStage(run: CheckRun): Promise<void> {
  if (!run.siteUrl) {
    run.site = { ...run.site, hasSite: false };
    await run.steps.step({ status: 'warn', text: 'No website found to open' });
    finishProduct(run);
    return;
  }
  run.site.hasSite = true;
  const host = await run.deps.browser();
  if (!host) {
    run.site.infraError = 'the browser could not start';
    run.degraded.push('browse:unavailable');
    await run.steps.step({ status: 'warn', text: 'The browser could not start, the site was not opened' });
    finishProduct(run);
    return;
  }
  const domain = run.domain ?? normalizeDomain(new URL(run.siteUrl).hostname);
  const evmChain = run.chain && CHAINS[run.chain].family === 'evm' ? run.chain : null;
  try {
    run.session = await host.newSession({ evmChainId: evmChainIdHex(evmChain), wallet: { readRpc: readRpcFor(run) } });

    const opened = await runStage(run, 'open', run.limits.open, ctx => openStage(run, domain, ctx));
    if (!opened.ok && !run.siteInfo) {
      run.site.loaded = false;
      run.site.error = opened.reason === 'timeout' ? 'timed out' : 'could not be opened';
      await run.steps.step({ status: 'fail', text: `${domain} didn't load (${run.site.error})` });
    }
    run.steps.setProgress(0.12);

    if (run.site.loaded && !run.site.landingBlocked) {
      const docsReserve = Math.min(run.limits.docs, 15_000);
      const exploreMs = Math.min(run.limits.explore, Math.max(5000, run.left() - docsReserve));
      const res = await runStage(run, 'explore', exploreMs, ctx => exploreStage(run, ctx));
      if (!res.ok && res.reason !== 'skipped') {
        await run.steps.step({ status: 'warn', text: res.reason === 'timeout' ? 'Ran out of time trying the app' : 'The browser agent stopped with an error' });
      }
    }
    run.steps.setProgress(0.45);

    if (run.site.loaded) {
      const res = await runStage(run, 'docs', run.limits.docs, ctx => docsStage(run, ctx));
      if (!res.ok) {
        run.docs.timedOut = res.reason === 'timeout';
        run.docs.stepIdx = await run.steps.step({
          status: 'warn',
          text: res.reason === 'timeout' ? 'Docs link timed out' : res.reason === 'skipped' ? 'Docs not checked: out of time' : 'Docs could not be checked',
          caption: 'Opening docs',
          url: run.docs.link,
        });
      }
    }
  } catch (e) {
    // a browser failure is ours, not the project's: keep what was seen and move on
    run.log.error('browse stage failed', e);
    run.degraded.push('browse:error');
    if (!run.site.loaded) run.site.infraError = 'browser error';
    await run.steps.step({ status: 'warn', text: 'The browser hit an error; the site was only partly checked' });
  } finally {
    const session = run.session;
    if (session) {
      const w = session.wallet;
      run.walletSummary = { requested: w.requested, connected: w.connected, methods: [...w.methods] };
      run.consoleErrors = [...session.pageErrors.map(e => e.message), ...session.consoleErrors].slice(0, 20);
    }
    await run.session?.close();
    run.steps.setProgress(0.55);
  }
  finishProduct(run);
}

function finishProduct(run: CheckRun) {
  const x = run.explorer?.result ?? null;
  run.product = productSignals(run.site, x, run.docs);
}

async function openStage(run: CheckRun, domain: string, ctx: StageCtx): Promise<void> {
  const session = run.session!;
  const steps = run.steps.scoped(ctx.signal);
  await steps.step({ status: 'info', text: `Opening ${domain} in a clean browser`, url: run.siteUrl, caption: 'Loading page' });
  const o = await openSite(session, run.siteUrl!, Math.min(20_000, ctx.deadline - Date.now() - 2000));
  const shot = await screenshot(o.page);
  run.landingShot = shot;
  run.siteInfo = { url: run.siteUrl!, finalUrl: o.finalUrl, title: null, loadMs: o.loadMs, httpStatus: o.status };
  run.site.loaded = o.loaded;
  run.site.error = o.error;
  if (!o.loaded) {
    run.site.loadStepIdx = await steps.step({ status: 'fail', text: `${domain} didn't load (${o.error ?? 'no response'})`, url: run.siteUrl, caption: 'Loading page', shot });
    return;
  }
  const text = await pageText(o.page);
  run.landing = text;
  if (text) {
    run.siteInfo.title = text.title || null;
    collectLinks(run, text.links);
  }
  run.site.loadStepIdx = await steps.step({
    status: 'ok',
    text: `Page loaded in ${secs(o.loadMs ?? 0)}`,
    url: o.finalUrl,
    caption: 'Reading the page',
    shot,
  });
  if (!run.domain) run.domain = domain;

  // a splash page ("Coming soon", "Join the waitlist") with no way into an app
  const summary = await domSummary(o.page);
  const p = await probe(o.page);
  const siteHost = normalizeDomain(new URL(run.siteUrl!).hostname);
  const hasEntry = summary.elements.some(e => launchRank(e.text) >= 0 || CONNECT_RE.test(e.text) || (!!e.href && isAppUrl(e.href, siteHost)));
  const allText = `${text?.hero ?? ''}\n${text?.text ?? ''}`;
  run.site.claimsLive = LIVE_RE.test(allText);
  if (!hasEntry && p.textLen < 1500) {
    if (WAITLIST_RE.test(allText) && p.emailInput) run.site.landingBlocked = 'waitlist';
    else if (COMING_SOON_RE.test(allText)) run.site.landingBlocked = 'coming_soon';
    if (run.site.landingBlocked) {
      run.site.loadStepIdx = await steps.step({
        status: 'warn',
        text: run.site.landingBlocked === 'waitlist' ? 'The site is only a waitlist signup' : "The site is only a 'Coming soon' page",
        url: o.finalUrl,
        caption: 'Reading the page',
      });
    }
  }
}

async function exploreStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const session = run.session!;
  const maxActions = Math.max(1, run.env.CHECK_MAX_AGENT_ACTIONS);
  run.explorer = new Explorer({
    session,
    ai: run.deps.ai,
    aiCtx: run.aiCtx(ctx.signal),
    steps: run.steps.scoped(ctx.signal),
    siteUrl: run.siteInfo?.finalUrl ?? run.siteUrl!,
    maxActions,
    deadline: ctx.deadline,
    signal: ctx.signal,
    simulate: simulator(run),
    onAction: n => run.steps.setProgress(0.12 + 0.33 * Math.min(1, n / maxActions)),
  });
  await run.explorer.run();
}

async function docsStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const session = run.session!;
  const steps = run.steps.scoped(ctx.signal);
  const siteHost = run.siteUrl ? normalizeDomain(new URL(run.siteUrl).hostname) : null;
  const landingUrl = (run.siteInfo?.finalUrl ?? run.siteUrl ?? '').replace(/#.*$/, '').replace(/\/+$/, '');
  let link = findDocsLink(run.landing?.links ?? [], siteHost);
  if (link && link.replace(/#.*$/, '').replace(/\/+$/, '') === landingUrl) link = null;
  run.docs.link = link;
  run.links.docs = link;
  if (!link) {
    run.docs.stepIdx = await steps.step({ status: 'warn', text: 'Docs: no docs link on the site', caption: 'Opening docs' });
    return;
  }
  if (!(await session.allowed(link))) {
    run.docs.stepIdx = await steps.step({ status: 'warn', text: 'Docs: link blocked by the SSRF guard', caption: 'Opening docs', url: link });
    return;
  }
  const result = await crawlDocs(session, link, { siteHost, deadline: ctx.deadline - 500, signal: ctx.signal });
  run.docs.result = result;
  run.docs.timedOut = result.timedOut;
  collectLinks(run, result.links);
  const d = docsSignal({ ...run.docs, stepIdx: null }, true, true);
  run.docs.stepIdx = await steps.step({ status: d.e.signal, text: d.e.text, url: link, caption: 'Opening docs', shot: result.shot });
}

