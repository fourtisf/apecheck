/**
 * Shape of Check.evidence (Json column). Written by the worker pipeline, read by the API mappers.
 * Every field is optional: a stage that timed out simply leaves its part empty.
 */
export interface CheckEvidence {
  /** evidence sentences per signal, as the log shows them */
  launch?: string;
  flow?: string;
  docs?: string;
  git?: string;
  acct?: string;

  /** X account facts (People tab) */
  people?: {
    handle?: string | null;
    name?: string | null;
    createdAt?: string | null;
    followers?: number | null;
    following?: number | null;
    verified?: boolean | null;
    /** times the handle was renamed; null = unknown (needs a third-party source) */
    renamed?: number | null;
    /** follower quality sentence, null when unknown */
    quality?: string | null;
    team?: string | null;
    teamSignal?: 'ok' | 'warn' | 'fail' | null;
    bio?: string | null;
    pinned?: string | null;
  };

  github?: {
    org?: string | null;
    repos: {
      fullName: string;
      url: string;
      fork: boolean;
      commits: number;
      contributors: number;
      firstCommit: string | null;
      lastCommit: string | null;
      stars?: number;
    }[];
    totalCommits: number;
    /** most commits landed within CONFIG.gitBurstHours of the token launch */
    burst: boolean;
    found: boolean;
  } | null;

  docsInfo?: {
    url?: string | null;
    status?: number | null;
    pages?: number | null;
    lastUpdated?: string | null;
    brokenLinks?: number | null;
    depth?: number | null;
  } | null;

  site?: {
    url: string;
    finalUrl?: string | null;
    title?: string | null;
    loadMs?: number | null;
    loaded: boolean;
    httpStatus?: number | null;
    consoleErrors?: string[];
    waitlist?: boolean;
    comingSoon?: boolean;
    deadButtons?: string[];
    appUrl?: string | null;
    /** what the mock wallet saw */
    wallet?: {
      requested: boolean;
      connected: boolean;
      methods: string[];
      tx?: { reached: boolean; simulated: 'ok' | 'fail' | 'skipped' | null; chain?: string | null; detail?: string | null } | null;
    };
  } | null;

  links?: {
    site?: string | null;
    x?: string | null;
    github?: string[];
    docs?: string | null;
    telegram?: string | null;
    discord?: string | null;
  };

  market?: {
    priceUsd?: number | null;
    mc?: number | null;
    fdv?: number | null;
    liquidityUsd?: number | null;
    vol5m?: number | null;
    vol24h?: number | null;
    ch24?: number | null;
    pairAddress?: string | null;
    pairUrl?: string | null;
    dex?: string | null;
    pairCreatedAt?: string | null;
  } | null;

  post?: { id: string; author: string; authorId?: string | null; text: string; createdAt?: string | null } | null;

  /**
   * The coin is a contract DexScreener lists only on a chain ApeCheck has no on-chain reads for (Sonic, Polygon…):
   * named, never checked or scored. `chain` is that chain's name ("Sonic"), `address` the contract (lowercase).
   * `site`: the domain from the token's info that the check moved to (a pasted or tagged contract whose token info
   * links the project's website: the verdict is for that site); null when the check stayed on what was pasted.
   */
  otherChain?: { chain: string; address: string; site?: string | null } | null;

  /** step count estimate for progress ("Step 3 of 12") */
  stepsExpected?: number;
  /** which AI implementation ran: real model or the heuristic stub */
  ai?: { mode: 'anthropic' | 'heuristic'; judgeModel?: string | null; fastModel?: string | null };
  /** adapters that were stubbed because a key/URL was missing */
  stubbed?: string[];
  /** stages that timed out or errored, e.g. ["docs:timeout"] */
  degraded?: string[];
}

/**
 * Check.evidence.otherChain as stored, or null when there is none or it doesn't hold up (a chain name, an EVM address
 * and, when set, a plain domain): the API, the report and the bot reply read it through here.
 */
export function otherChainOf(evidence: unknown): { chain: string; address: string; site: string | null } | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const o = (evidence as CheckEvidence).otherChain;
  if (!o || typeof o !== 'object' || typeof o.chain !== 'string' || typeof o.address !== 'string') return null;
  const chain = o.chain.trim();
  if (!chain || chain.length > 40 || !/^0x[0-9a-fA-F]{40}$/.test(o.address)) return null;
  const site = typeof o.site === 'string' && o.site.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(o.site) ? o.site.toLowerCase() : null;
  return { chain, address: o.address.toLowerCase(), site };
}

/** Rough step counts per input kind, used until the real count is known. */
export const STEPS_EXPECTED = { site: 10, post: 12, coin: 14 } as const;
