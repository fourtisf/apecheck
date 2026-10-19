/**
 * What a site "says", for change detection (re-check alerts, HANDOFF §8): the visible text of the HTML the server
 * sends, with everything that changes on every load taken out, so the fingerprint only moves when the words move.
 *
 *  1. scripts, styles, templates, inline SVG, comments and the <head> are dropped (the title and the meta / Open Graph
 *     description are kept: a single-page app shows little else without JavaScript);
 *  2. tags become spaces, entities are decoded, zero-width characters removed;
 *  3. volatile values become "#": every number (prices, market caps, counters, holders, timestamps, years, versions;
 *     subscript and superscript digits too, as in "$0.0₄12"; "1e9") with its currency sign, +/- sign, direction arrow
 *     (▲ ▼ ↑ ↓) and k/M/B/% unit, durations and countdowns ("1d 2h", "23h 59m"), dates (month and weekday names next
 *     to a number), clock times with am/pm/UTC, relative times ("5 minutes ago", "just now", "yesterday", "today"),
 *     transaction and block hashes (0x + 64 hex, base58 signatures, an id after "block", "tx", "commit", "build"…),
 *     and the plural after a number ("1 holder" / "2 holders");
 *  4. whitespace collapsed.
 *
 * Words, links' text, buttons, headings, "Coming soon" all stay, and a contract address (0x + 40 hex, a Solana or
 * Tron base58 address) stays whole: the site swapping its contract is a change.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', laquo: '«', raquo: '»',
  times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,10});?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};

/** The title and the description a page declares (meta name=description, og:/twitter: title and description). */
export function pageMeta(html: string): string[] {
  const out: string[] = [];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (title) out.push(title[1]);
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'name') ?? attr(m[0], 'property') ?? '').toLowerCase();
    if (['description', 'og:title', 'og:description', 'twitter:title', 'twitter:description'].includes(key)) {
      const c = attr(m[0], 'content');
      if (c) out.push(`${key}: ${c}`);
    }
  }
  return out.map(s => decodeEntities(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The text a visitor sees in the server's HTML (no normalisation of volatile values yet). */
export function visibleText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg|noscript|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // an unclosed script/style swallows the rest of the document in a browser too
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  return decodeEntities(s)
    .replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const TZ = '(?:utc|gmt|z|est|edt|cst|cdt|mst|mdt|pst|pdt|cet|cest|eet|eest|bst|ist|jst|kst|hkt|sgt|wib|aest|aedt)';
const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?';

/** ASCII, subscript and superscript digits */
const D = '[0-9\\u2080-\\u2089\\u2070\\u00b9\\u00b2\\u00b3\\u2074-\\u2079]';
const NUMBER = new RegExp(`${D}+(?:[.,:/\\-–]${D}+)*`, 'g');
const ARROW = '[▲▼△▽▴▾↑↓↗↘⬆⬇🔺🔻]\\ufe0f?';
const ARROW_NEXT_TO_NUMBER = new RegExp(`${ARROW}\\s?#|#\\s?${ARROW}`, 'gu');
/** an id after a word that names one ("block 0x9f3a…", "tx 3Xk9…", "commit a1b2c3d"): letters and digits, with a digit */
const LABELLED_ID = /\b(block|blk|tx|txn|txid|hash|commit|build|sig|signature)\b(\s*[:#]?\s*)(?=(?:0x)?[0-9a-z]*\d)(?:0x)?[0-9a-z]{6,}\b/gi;
/** digits of an address → letters no address or number uses, so the number pass leaves the address whole */
const keepDigits = (s: string) => s.replace(/[0-9]/g, d => 'αβγδεζηθικ'[Number(d)]);

/** `text` with every value that changes on its own (numbers, dates, times, relative times, hashes) replaced by "#". */
export function stripVolatile(text: string): string {
  return (
    text
      // transaction / block hashes and signatures, ids after a word that names one
      .replace(/\b0x[0-9a-f]{64}\b/gi, '#')
      .replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, '#')
      .replace(LABELLED_ID, '$1$2#')
      // contract addresses stay whole (EVM 0x + 40 hex; Solana / Tron base58)
      .replace(/\b0x[0-9a-f]{40}\b/gi, a => keepDigits(a.toLowerCase()))
      .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, keepDigits)
      // relative times
      .replace(/\b(?:just now|moments? ago|a few (?:seconds|minutes) ago|(?:an?|\d+)\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?|mo|months?|y|yr|years?)\s+ago)\b/gi, ' ')
      .replace(/\b(?:today|tonight|yesterday|tomorrow)\b/gi, ' ')
      // numbers of any shape: 1e9 · 1,234.56 · 12:30:05 · 2026-10-19 · 19/10/2026 · 0.000012 · 0.0₄12 · v1.2.3
      .replace(/\b\d+(?:\.\d+)?e[+-]?\d+\b/gi, '#')
      .replace(NUMBER, '#')
      // units, signs, currencies and direction arrows around a number
      .replace(/#\s?(?:[kmbt]|bn|mm|mn|k\+|x|%|st|nd|rd|th)(?![\p{L}\p{N}])/giu, '#')
      .replace(/[$€£¥₿Ξ]\s?#|#\s?(?:usd|usdc|usdt|eth|sol|bnb|btc)\b/gi, '#')
      .replace(/[+\-−~≈<>]\s?#/g, '#')
      .replace(ARROW_NEXT_TO_NUMBER, '#')
      // dates and clock times
      .replace(new RegExp(`\\b${WEEKDAY}\\b,?\\s*(?=(?:${MONTH}\\b|#))`, 'gi'), '')
      .replace(new RegExp(`\\b${MONTH}\\.?\\s*#|#\\s*${MONTH}\\b\\.?`, 'gi'), '#')
      .replace(new RegExp(`#\\s?(?:a\\.?m\\.?|p\\.?m\\.?|${TZ})(?![\\p{L}\\p{N}])`, 'giu'), '#')
      // durations and countdowns ("1d 2h", "23h 59m", "5 days")
      .replace(/#\s?(?:d|h|s|days?|hrs?|hours?|mins?|minutes?|secs?|seconds?|wks?|weeks?)(?![\p{L}\p{N}])/giu, '#')
      // the plural after a number ("1 holder" / "2 holders")
      .replace(/#(\s?)(\p{L}{2,}?)s(?![\p{L}\p{N}])/giu, '#$1$2')
      // runs of numbers ("# / #", "# - #", "#:#", "# #") are one value
      .replace(/#(?:[\s,.:/\-–|·•]*#)+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Everything a site's fingerprint is computed from: its declared title/description and its visible text, normalised. */
export function siteFingerprintText(html: string): string {
  return [...pageMeta(html), visibleText(html)].map(stripVolatile).filter(Boolean).join('\n');
}
