/**
 * Text patterns the browser agent and the heuristic stand-in share: what an app entry, a wallet
 * button or a main action looks like, and what waitlist / coming-soon / error screens say.
 */

/** Ranked app-entry labels (lower index = better). */
export const LAUNCH_LABELS: RegExp[] = [
  /^(launch|open|enter|use|go to)( the)? (d?app|platform|terminal|dashboard|exchange)\b/i,
  /^(launch app|open app|enter app|dapp|app)$/i,
  /^(trade|swap|start trading|trade now|swap now)$/i,
  /^(get started|start now|start|try it( now| out)?|try now|try (the )?demo)$/i,
  /^(play( now)?|dashboard|terminal|mint( now)?|stake( now)?|buy( now)?|bridge( now)?|earn)$/i,
  /\b(launch app|open app|enter app|go to app|use app)\b/i,
];

export const CONNECT_RE = /^(connect( a)?( your)? wallet|connect|sign in with (a )?wallet|log ?in with wallet)$|\bconnect wallet\b/i;

/** Wallet choices inside a connect modal. */
export const WALLET_CHOICE_RE = /\b(metamask|phantom|browser wallet|injected|detected|installed)\b/i;

/** The main action once inside an app. */
export const MAIN_ACTION_RE =
  /^(swap|trade|buy|sell|mint|stake|unstake|deposit|withdraw|bridge|create|generate|deploy|launch|start|play|submit|confirm|review( swap| order)?|place (order|bet)|open (position|long|short)|long|short|borrow|lend|supply|claim|run|send|ask|chat|bet|spin|join)\b/i;

/** Labels the agent never clicks: they leave the product or need a human. */
export const AVOID_RE =
  /\b(docs?|documentation|whitepaper|litepaper|gitbook|twitter|x\.com|discord|telegram|github|medium|blog|terms|privacy|cookie|careers|jobs|faq|contact|support|newsletter|subscribe|sign ?up|log ?in|sign ?in|register|email|audit report|brand|press|media kit|linktree|youtube|instagram|tiktok|reddit|coingecko|coinmarketcap|dexscreener|dextools|etherscan|basescan|solscan|bscscan)\b/i;

export const SOCIAL_HOST_RE = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|discord\.gg|discord\.com|github\.com|medium\.com|youtube\.com|youtu\.be|linktr\.ee|instagram\.com|tiktok\.com|reddit\.com)$/i;

export const WAITLIST_RE =
  /\b(join (the |our )?wait ?list|wait ?list|waiting list|get early access|request (early )?access|early access|get notified|notify me|be the first to know|reserve your spot|join (the )?whitelist|sign up for (early access|updates))\b/i;

export const COMING_SOON_RE =
  /\b(coming soon|launching soon|available soon|stay tuned|under construction|not (yet )?(live|available)|unlocks? (after|at|soon)|opens? soon|work in progress|soon™)\b/i;

export const ERROR_SCREEN_RE =
  /\b(something went wrong|an error (has )?occurred|unexpected error|application error|failed to (load|fetch)|internal server error|transaction failed|simulation failed|oops[,!]? .{0,30}error|error: )/i;

export const NOT_FOUND_RE = /\b(404|page not found|this page (could not|can't|cannot) be found|not found)\b/i;

export const NEEDS_FUNDS_RE =
  /\b(insufficient (funds|balance|lamports|liquidity)|exceeds balance|transfer amount exceeds|not enough (funds|balance|sol|eth)|no record of a prior credit|AccountNotFound|insufficient funds for (gas|rent))\b/i;

/** Simulation errors that say nothing about the project (our RPC is missing or down). */
export const SIM_INFRA_RE =
  /\b(no RPC configured|simulation unavailable|timed? ?out|ECONN\w*|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|outbound proxy|rate limit|HTTP 5\d\d|429|bad JSON)\b/i;

export const DOCS_TEXT_RE = /^(docs?|documentation|developer docs|developers|read the docs|gitbook|whitepaper|litepaper|technical paper)$/i;
export const DOCS_HINT_RE = /\b(docs?|documentation|whitepaper|litepaper|gitbook|developers?)\b/i;

export const AUDIT_RE = /\baudit(ed|s)?\b|certik|hacken|peckshield|trail of bits|openzeppelin|halborn|zellic|spearbit|code4rena|sherlock|ottersec|cyfrin/i;

/** App-like routes reached after an entry click. */
export const APP_PATH_RE = /^\/(#\/)?(app|swap|trade|dashboard|terminal|launch|mint|stake|play|portfolio|earn|bridge|pool|pools|exchange|markets?|vaults?|agents?|chat|create)(\/|$|\?|#)/i;
export const APP_HOST_RE = /^(app|dapp|trade|swap|play|beta|launch|dashboard|terminal|stake|mint)\./i;

export function launchRank(text: string): number {
  const t = text.trim();
  if (!t || t.length > 40) return -1;
  for (let i = 0; i < LAUNCH_LABELS.length; i++) if (LAUNCH_LABELS[i].test(t)) return i;
  return -1;
}

export function isAppUrl(url: string, siteHost: string | null): boolean {
  try {
    const u = new URL(url);
    if (APP_HOST_RE.test(u.hostname)) return true;
    if (APP_PATH_RE.test(u.pathname + (u.hash.startsWith('#/') ? u.hash : ''))) return true;
    if (u.hash && APP_PATH_RE.test('/' + u.hash.replace(/^#\/?/, ''))) return true;
    return !!siteHost && u.hostname !== siteHost && u.hostname.endsWith('.' + siteHost.replace(/^www\./, '')) && !/^(docs|blog|www)\./i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Visible text with digits removed: animated counters and tickers don't count as a change. */
export const textSignature = (s: string) => s.replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim();
