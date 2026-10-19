/**
 * Heuristic stand-in for the AI stages: same interface as the Claude adapter, no network.
 * Used when ANTHROPIC_API_KEY is empty, and as the per-stage fallback when the model errors,
 * refuses or returns something that fails validation.
 */
import {
  CLAIM_KINDS,
  TUNING,
  clipSentence,
  normaliseClaims,
  type ClaimKind,
  type ClaimSource,
  type ClaimStatus,
  type ExtractedClaim,
  type Judged,
  type JudgedClaim,
  type Signal,
} from '@apecheck/core';
import {
  AVOID_RE,
  CONNECT_RE,
  MAIN_ACTION_RE,
  SOCIAL_HOST_RE,
  WALLET_CHOICE_RE,
  launchRank,
  isAppUrl,
} from '../browser/keywords';
import type {
  AiAdapter,
  AnswerData,
  BrowserAction,
  ClaimsInput,
  DomElement,
  ExploreObservation,
  ExploreState,
  JudgeInput,
  SignalEvidence,
} from './types';
import { coinSentence, gitSentence, productSentence } from './phrases';

/* ---------------- exploration ---------------- */

interface HeuristicMemory {
  clicked: string[];
  scrolls: number;
  triedMain: number;
}

const elKey = (e: DomElement) => `${e.text.toLowerCase()}|${e.href ?? ''}`;

function socialHref(href: string | null): boolean {
  if (!href) return false;
  try {
    return SOCIAL_HOST_RE.test(new URL(href).hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function heuristicExploreStep(state: ExploreState, obs: ExploreObservation): BrowserAction {
  const mem = state.memory as unknown as HeuristicMemory;
  mem.clicked ??= [];
  mem.scrolls ??= 0;
  mem.triedMain ??= 0;
  const f = obs.flags;

  if (f.txCaptured) return { tool: 'done', reason: 'The main flow reached a transaction' };
  if (f.waitlist) return { tool: 'done', reason: 'The app entry leads to a waitlist' };
  if (f.errorScreen) return { tool: 'done', reason: 'The app shows an error screen' };
  if (f.comingSoon && (f.appReached || mem.triedMain > 0)) return { tool: 'done', reason: "The flow stops at 'Coming soon'" };

  const clicked = new Set(mem.clicked);
  const usable = obs.summary.elements.filter(
    e => e.text && !e.disabled && !clicked.has(elKey(e)) && !AVOID_RE.test(e.text) && !socialHref(e.href) && e.text.length <= 60,
  );
  const modalOpen = !!obs.summary.modalText;
  const siteHost = hostOf(state.siteUrl);

  const choose = (e: DomElement): BrowserAction => {
    mem.clicked.push(elKey(e));
    return { tool: 'click', text: e.text };
  };
  const firstMatch = (re: RegExp, pool = usable) => pool.find(e => re.test(e.text.trim()));

  // a wallet picker is open: pick the injected test wallet
  if (modalOpen && !f.walletConnected) {
    const w = firstMatch(WALLET_CHOICE_RE, usable.filter(e => e.inModal)) ?? firstMatch(WALLET_CHOICE_RE);
    if (w) return choose(w);
  }

  if (!f.appReached) {
    const ranked = usable
      .map(e => {
        let r = launchRank(e.text);
        if (r < 0 && e.href && isAppUrl(e.href, siteHost) && e.text.length <= 30) r = 2;
        return { e, r };
      })
      .filter(x => x.r >= 0)
      .sort((a, b) => a.r - b.r || Number(b.e.inViewport) - Number(a.e.inViewport) || a.e.id - b.e.id);
    if (ranked.length) return choose(ranked[0].e);
    const connect = firstMatch(CONNECT_RE);
    if (connect) return choose(connect);
  } else if (!f.walletConnected && !f.walletRequested) {
    const connect = firstMatch(CONNECT_RE);
    if (connect) return choose(connect);
  }

  if (f.appReached || f.walletConnected) {
    const main = usable
      .filter(e => MAIN_ACTION_RE.test(e.text.trim()) && !CONNECT_RE.test(e.text))
      .sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.id - b.id)[0];
    if (main && mem.triedMain < 2) {
      mem.triedMain++;
      return choose(main);
    }
  }

  if (mem.scrolls < 1 && !f.appReached) {
    mem.scrolls++;
    return { tool: 'scroll', direction: 'down' };
  }
  return { tool: 'done', reason: f.appReached ? 'Nothing left to try in the app' : 'No way into an app on this site' };
}

/* ---------------- claims ---------------- */

const CUES: [ClaimKind, RegExp][] = [
  ['ai_agent', /\b(ai[- ]?agents?|autonomous agents?|agentic|ai[- ]powered|powered by ai|llms?|machine learning)\b/i],
  ['mainnet', /\b(mainnet|live on (base|ethereum|solana|bnb|bsc|arbitrum|robinhood)|deployed (on|to) (base|ethereum|solana|bnb|bsc|arbitrum|robinhood))\b/i],
  ['live_product', /\b(live now|now live|is live|live product|available now|try it (now|today)|use it (now|today)|in production|fully functional|working product|beta is live|real users)\b/i],
  ['open_source', /\b(open[- ]source|source code|open code|code is public|public repo(sitory)?|mit licen[sc]e|apache licen[sc]e)\b/i],
  ['docs', /\b(full documentation|documentation|docs\b|whitepaper|litepaper|developer guides?|technical paper)/i],
  ['team', /\b(doxx?ed|public team|experienced team|our team|team of|founders?|core contributors|built by (a team|veterans|ex-))\b/i],
  ['fair_launch', /\b(fair[- ]launch(ed)?|no presale|no pre-sale|stealth[- ]launch(ed)?|no team (allocation|tokens|bundle)|0% team|no vcs?|no insiders?)\b/i],
  ['audit', /\b(audited|audits?|security review)\b|certik|hacken|peckshield|trail of bits|halborn|zellic|spearbit|ottersec|cyfrin/i],
  ['partnership', /\b(partner(ed|ship|s)?|backed by|investors?|supported by|in collaboration with|integrat(ed|es|ion) with)\b/i],
];

/** Sentences of a text block, in order. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9$@"“©])/)) {
      const s = part.replace(/\s+/g, ' ').trim();
      if (s.startsWith('©')) continue;
      if (s.length >= 8 && s.length <= 220 && s.split(' ').length >= 2) out.push(s);
    }
  }
  return out;
}

export function heuristicClaims(input: ClaimsInput): ExtractedClaim[] {
  const blocks: [ClaimSource, string][] = [
    ['site_hero', input.hero],
    ['post', input.post],
    ['x_bio', input.bio],
    ['docs', input.docs],
    ['footer', input.footer],
  ];
  const perKind = new Map<ClaimKind, number>();
  const found: ExtractedClaim[] = [];
  for (const [source, text] of blocks) {
    if (!text) continue;
    for (const s of sentences(text)) {
      const hit = CUES.find(([, re]) => re.test(s));
      if (!hit) continue;
      const kind = hit[0];
      // docs mentioning "documentation" is not a claim about having docs
      if (source === 'docs' && kind === 'docs') continue;
      if ((perKind.get(kind) ?? 0) >= 2) continue;
      perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
      found.push({ text: s.length > 120 ? clipSentence(s, 120) : s, source, kind });
    }
  }
  // most checkable kinds first, keeping copy order within a kind
  const order = (k: ClaimKind) => CLAIM_KINDS.indexOf(k);
  found.sort((a, b) => order(a.kind) - order(b.kind));
  return normaliseClaims({ claims: found.slice(0, TUNING.maxClaims * 2) });
}

/* ---------------- judge ---------------- */

const STATUS_BY_SIGNAL: Record<Signal, ClaimStatus> = { ok: 'seen_working', warn: 'not_seen', fail: 'contradicted' };
const FACT_STATUS_BY_SIGNAL: Record<Signal, ClaimStatus> = { ok: 'checks_out', warn: 'not_seen', fail: 'contradicted' };

function judged(index: number, status: ClaimStatus, ev: SignalEvidence | null, fallback: string): JudgedClaim {
  return { index, status, evidence: ev?.text || fallback, stepIdx: ev?.stepIdx ?? null };
}

export function heuristicJudge(input: JudgeInput): Judged {
  const p = input.product;
  const acct = input.people.acct ?? { signal: 'warn' as Signal, text: 'No X account to check', stepIdx: null };
  const git = input.people.git ?? { signal: 'warn' as Signal, text: 'GitHub: not checked', stepIdx: null };
  const claims: JudgedClaim[] = input.claims.map((c, i) => {
    switch (c.kind) {
      case 'live_product':
      case 'mainnet':
        return judged(i, STATUS_BY_SIGNAL[p.launch.signal], p.launch, 'Nothing on the site could be opened');
      case 'ai_agent': {
        const flow = p.launch.signal === 'ok' ? p.flow : p.launch;
        return judged(i, STATUS_BY_SIGNAL[flow.signal], flow, 'The main flow was not reached');
      }
      case 'open_source':
        return judged(i, STATUS_BY_SIGNAL[git.signal], git, 'No repository was found');
      case 'docs':
        return judged(i, STATUS_BY_SIGNAL[p.docs.signal], p.docs, 'No docs were found');
      case 'team':
        return judged(i, FACT_STATUS_BY_SIGNAL[acct.signal], acct, 'No X account to check');
      case 'fair_launch': {
        const b = input.coin?.evidence.bundle;
        if (!input.coin || !b) return judged(i, 'not_seen', null, 'No launch data to check the claim against');
        return judged(i, FACT_STATUS_BY_SIGNAL[input.coin.signals.bundle], b, 'No launch data');
      }
      case 'audit':
        return input.auditLink
          ? judged(i, 'checks_out', { signal: 'ok', text: `Audit link found on the site: ${input.auditLink.url}`, stepIdx: input.auditLink.stepIdx }, '')
          : judged(i, 'not_seen', null, 'No audit report linked from the site or docs');
      case 'partnership':
        return judged(i, 'not_seen', null, 'Partnerships were not checked; nothing on the site confirms them');
      default:
        return judged(i, 'not_seen', null, 'Nothing the agent saw confirms or contradicts this');
    }
  });
  const prodS = productSentence(input.causes, p);
  const gitS = gitSentence(git.signal, input.git);
  const coinS = input.coin ? coinSentence(input.coin) : '';
  const summary = clipSentence(`${prodS}; ${gitS}.` + (input.coin && input.coin.score < 60 ? ` ${coinS}.` : ''), 180);
  return {
    claims,
    acct: acct.signal,
    git: git.signal,
    summary,
    coinSummary: input.coin ? clipSentence(coinS + '.', 180) : null,
  };
}

/* ---------------- follow-up answers ---------------- */

export function heuristicAnswer(question: string, d: AnswerData): string {
  const q = question.toLowerCase();
  const ev = d.evidence;
  if (/deploy|dev wallet|fund/.test(q)) {
    if (!d.coin) return 'There is no coin linked to this one yet, so there is no deployer to trace.';
    const funded = d.coin.fundedFrom ? `The deployer was funded from ${d.coin.fundedFrom}. ` : '';
    return d.coin.deployerLine ? `${funded}Track record: ${d.coin.deployerLine}.` : `${funded}The deployer's history was not available for this check.`;
  }
  if (/bundl|snip|launch block/.test(q)) {
    if (!d.coin) return 'No coin linked, so there is no supply to check.';
    return d.coin.bundlePct != null
      ? `${d.coin.bundlePct}% of supply went to ${d.coin.bundleWallets ?? 'several'} wallets in the launch block.`
      : 'Bundle data was not available for this check.';
  }
  if (/holder|whale|top ?10|concentrat/.test(q)) {
    if (!d.coin) return 'No coin linked, so there are no holders to check.';
    return d.coin.top10Pct != null ? `The top 10 holders own ${d.coin.top10Pct}%${d.coin.lp ? `; liquidity is ${d.coin.lp.toLowerCase()}` : ''}.` : 'Holder data was not available for this check.';
  }
  if (/liquidity|\blp\b|rug/.test(q)) {
    if (!d.coin) return 'No coin linked, so there is no liquidity to check.';
    return d.coin.lp ? `Liquidity: ${d.coin.lp}. Authorities: ${d.coin.authorities ?? 'unknown'}.` : 'LP status was not available for this check.';
  }
  if (/github|code|repo|open.?source/.test(q)) return ev.git ? `GitHub: ${ev.git}.` : 'The code was not checked.';
  if (/team|doxx|founder|who/.test(q)) return ev.acct ? `${ev.acct}. The check looks at the account, not who runs it.` : 'There was no X account to check.';
  if (/doc/.test(q)) return ev.docs ? `Docs: ${ev.docs}.` : 'No docs were checked.';
  if (/use|app|work|live|product|try/.test(q)) {
    const parts = [ev.launch, d.signals.launch === 'ok' ? ev.flow : null].filter(Boolean);
    return parts.length ? parts.join('. ') + '.' : d.summary ?? 'The app was not tested.';
  }
  return d.summary ?? 'This check has no answer for that.';
}

/* ---------------- adapter ---------------- */

export class HeuristicAi implements AiAdapter {
  readonly mode = 'heuristic' as const;
  readonly judgeModel = null;
  readonly fastModel = null;

  newExplore(siteUrl: string): ExploreState {
    return { siteUrl, memory: {} };
  }
  async exploreStep(state: ExploreState, obs: ExploreObservation): Promise<BrowserAction> {
    return heuristicExploreStep(state, obs);
  }
  async extractClaims(input: ClaimsInput): Promise<ExtractedClaim[]> {
    return heuristicClaims(input);
  }
  async judge(input: JudgeInput): Promise<Judged> {
    return heuristicJudge(input);
  }
  async answer(question: string, data: AnswerData): Promise<string> {
    return heuristicAnswer(question, data);
  }
}

