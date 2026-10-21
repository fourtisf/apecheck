/** Check.evidence (CheckEvidence from @apecheck/core) assembled from the run state. */
import { STEPS_EXPECTED, type CheckEvidence } from '@apecheck/core';
import type { CheckRun } from './context';

export function buildEvidence(run: CheckRun): CheckEvidence {
  const x = run.explored;
  const p = run.product;
  const ev: CheckEvidence = {
    stepsExpected: STEPS_EXPECTED[run.kind],
    ai: { mode: run.aiFallbacks.size ? 'heuristic' : run.deps.ai.mode, judgeModel: run.deps.ai.judgeModel, fastModel: run.deps.ai.fastModel },
  };
  if (p) {
    ev.launch = p.plain.launch;
    ev.flow = p.plain.flow;
    ev.docs = p.plain.docs;
  }
  ev.git = run.git.plain ?? 'not checked';
  ev.acct =
    run.acct.plain ??
    (run.handle
      ? `@${run.handle}: account could not be read`
      : run.site.hasSite && !run.site.loaded
        ? "X account unknown (the site couldn't be read)"
        : 'No X account linked to the project');

  const u = run.xUser;
  if (u || run.handle) {
    ev.people = {
      handle: u?.handle ?? run.handle,
      name: u?.name ?? null,
      createdAt: u?.createdAt ?? null,
      followers: u?.followers ?? null,
      following: u?.following ?? null,
      verified: u?.verified ?? null,
      renamed: run.acct.renamed ?? null,
      quality: null,
      team: null,
      teamSignal: null,
      bio: u?.description ?? null,
      pinned: u?.pinnedText ?? null,
    };
  }

  const g = run.git.facts;
  ev.github = g
    ? {
        org: g.originals[0]?.fullName.split('/')[0] ?? g.repos[0]?.fullName.split('/')[0] ?? null,
        repos: g.repos.slice(0, 10).map(r => ({
          fullName: r.fullName,
          url: r.url,
          fork: r.fork,
          commits: r.commits,
          contributors: r.contributors,
          firstCommit: r.firstCommit,
          lastCommit: r.lastCommit,
          stars: r.stars,
        })),
        totalCommits: g.totalCommits,
        burst: g.burst,
        found: g.originals.length > 0,
      }
    : null;

  const d = run.docs.result;
  ev.docsInfo = run.docs.link
    ? {
        url: run.docs.link,
        status: d?.status ?? null,
        pages: d?.pages ?? null,
        lastUpdated: d?.lastUpdated ? d.lastUpdated.toISOString() : null,
        brokenLinks: d?.broken ?? null,
        depth: d?.depth ?? null,
      }
    : null;

  if (run.site.hasSite && run.siteUrl) {
    const w = run.walletSummary;
    ev.site = {
      url: run.siteUrl,
      finalUrl: run.siteInfo?.finalUrl ?? null,
      title: run.siteInfo?.title ?? null,
      loadMs: run.siteInfo?.loadMs ?? null,
      loaded: run.site.loaded,
      httpStatus: run.siteInfo?.httpStatus ?? null,
      consoleErrors: run.consoleErrors.slice(0, 10),
      waitlist: run.site.landingBlocked === 'waitlist' || !!x?.waitlist,
      comingSoon: run.site.landingBlocked === 'coming_soon' || !!x?.comingSoon,
      deadButtons: x?.deadButtons.slice(0, 10) ?? [],
      appUrl: x?.appUrl ?? null,
      wallet: {
        requested: w?.requested ?? false,
        connected: w?.connected ?? false,
        methods: w?.methods ?? [],
        tx: x?.tx
          ? { reached: true, simulated: x.tx.simulated, chain: x.tx.chain, detail: x.tx.detail }
          : null,
      },
    };
  } else ev.site = null;

  ev.links = {
    site: run.links.site,
    x: run.links.x,
    github: run.links.github,
    docs: run.links.docs,
    telegram: run.links.telegram,
    discord: run.links.discord,
  };

  const m = run.market;
  ev.market = m
    ? {
        priceUsd: m.priceUsd, mc: m.mc, fdv: m.fdv, liquidityUsd: m.liquidityUsd, vol5m: m.vol5m, vol24h: m.vol24h, ch24: m.ch24,
        pairAddress: m.pairAddress, pairUrl: m.pairUrl, dex: m.dex, pairCreatedAt: m.pairCreatedAt,
      }
    : null;

  ev.post = run.post
    ? { id: run.post.id, author: run.post.authorHandle ?? '', authorId: run.post.authorId, text: run.post.text, createdAt: run.post.createdAt }
    : null;

  const stubbed = new Set([...run.sources.stubbed(), ...run.stubbed]);
  if (run.deps.ai.mode === 'heuristic') stubbed.add('ai');
  ev.stubbed = [...stubbed];
  const degraded = [...run.degraded, ...[...run.aiFallbacks.entries()].map(([stage, why]) => `ai:${stage}:${why}`)];
  ev.degraded = degraded;
  return ev;
}
