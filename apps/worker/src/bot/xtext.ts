/**
 * Counting characters the way X does (twitter-text v3 "weighted length"), so a reply never goes over 280:
 *  - a code point in U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F or U+2032–U+2037 counts 1, every other code point
 *    2 (CJK, most symbols, "…" U+2026 too);
 *  - an emoji counts 2 however many code points it is made of (ZWJ families, flags, skin tones, keycaps);
 *  - a URL counts 23 whatever its length (t.co wrapping), with or without "https://".
 * Text is NFC-normalised first, as X does. Pure functions.
 *
 * xLength() is an UPPER BOUND on X's count, never less: X links every domain under any of its ~1,500 TLDs, and the
 * list below is only a subset. A token that looks like a domain under a TLD not listed here ("claim.ninja",
 * "app.orbit.market", "jup.ag/swap") counts max(its own weight, 23); one under a listed TLD that X surely links
 * counts exactly 23. Counting "node.js" as a possible link only cuts a reply a few characters shorter; counting a
 * real link short would make X refuse the reply as too long.
 */

export const X_MAX_LENGTH = 280;
export const X_URL_LENGTH = 23;

const LIGHT: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const isLight = (cp: number) => LIGHT.some(([a, b]) => cp >= a && cp <= b);

// a grapheme with any pictographic code point, a regional-indicator flag or a keycap is one emoji (counts 2)
const RE_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// top-level domains X links without "https://" (a practical subset of twitter-text's list)
const TLDS = [
  'com', 'net', 'org', 'io', 'xyz', 'app', 'ai', 'fi', 'fun', 'gg', 'so', 'sh', 'co', 'dev', 'tech', 'network', 'money',
  'finance', 'exchange', 'world', 'lol', 'meme', 'bot', 'agent', 'wtf', 'cc', 'me', 'to', 'tv', 'club', 'site', 'online',
  'pro', 'vip', 'one', 'zone', 'build', 'tools', 'capital', 'digital', 'cash', 'pay', 'trade', 'markets', 'info', 'biz',
  'us', 'uk', 'de', 'fr', 'jp', 'cn', 'kr', 'ru', 'in', 'br', 'ca', 'au', 'eu', 'ch', 'nl', 'es', 'it', 'link', 'live',
  'news', 'art', 'game', 'games', 'ly', 'gl', 'im', 'is', 'sg', 'hk', 'id', 'vc', 'ventures', 'global', 'space', 'store',
  'shop', 'blog', 'page', 'land', 'life', 'today', 'run', 'wiki', 'chat', 'social', 'top', 'win', 'bet', 'cloud', 'labs',
];
// what X takes into a URL's path (twitter-text: ASCII URL characters, Latin accents, Cyrillic); a CJK character ends it
const PATH = String.raw`(?:\/[A-Za-z0-9!$%&'()*+,\-./:;=?@\[\]_~#|À-ɏЀ-ӿḀ-ỿ]*)?`;
const PORT = String.raw`(?::\d{2,5})?`;
// a host after "https://" (X also links Unicode hosts there)
const SCHEME = String.raw`https?:\/\/[^\s<>"\/?#]+${PORT}${PATH}`;
/** A link X surely makes: a scheme URL, or a domain under one of TLDS. */
const RE_URL = new RegExp(
  String.raw`(?<![\w@＠.\/-])(?:${SCHEME}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS.join('|')})(?![a-z0-9-])${PORT}${PATH})`,
  'giu',
);
// a domain label: ASCII and Latin letters (X's protocol-less domains), digits, "-" and "_"
const LABEL = String.raw`[a-z0-9À-ÖØ-öø-ɏ̀-ͯḀ-ỿ](?:[a-z0-9_\-À-ÖØ-öø-ɏ̀-ͯḀ-ỿ]*[a-z0-9À-ÖØ-öø-ɏ̀-ͯḀ-ỿ])?`;
// any top-level domain: 2–63 ASCII letters, punycode, or a non-ASCII name (X has IDN TLDs)
const ANY_TLD = String.raw`(?:[a-z]{2,63}(?![a-z0-9-])|xn--[a-z0-9-]{1,59}(?![a-z0-9-])|[\p{L}\p{M}]{2,63}(?![\p{L}\p{M}\p{N}_-]))`;
/**
 * Anything X might link: a scheme URL, or a dotted name whose last label could be a TLD. A superset of RE_URL; a
 * match may start right after a "." (X links "example.com" inside "日本.example.com").
 */
const RE_LINK = new RegExp(
  String.raw`(?<![A-Za-z0-9_@＠À-ÖØ-öø-ɏ̀-ͯḀ-ỿ])(?:${SCHEME}|(?:${LABEL}\.)+${ANY_TLD}${PORT}${PATH})`,
  'giu',
);
const TLD_SET = new Set(TLDS);
// X leaves trailing punctuation out of a URL
const TRAILING = /[.,;:!?'")\]}…]+$/u;

function weigh(s: string): number {
  let n = 0;
  for (const { segment } of graphemes.segment(s)) {
    if (RE_EMOJI.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) n += isLight(ch.codePointAt(0)!) ? 1 : 2;
  }
  return n;
}

function spansOf(re: RegExp, text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(TRAILING, '');
    if (url) out.push([m.index!, m.index! + url.length]);
  }
  return out;
}

/**
 * Everything in `text` that X might turn into a link: every URL, and every token that looks like a domain under
 * any TLD ([start, end) offsets into the NFC text). Errs on the side of too many ("node.js" is one).
 */
export function urlSpans(text: string): [number, number][] {
  return spansOf(RE_LINK, text);
}

/** `text` holds something X might link (see urlSpans). */
export function hasLink(text: string): boolean {
  return urlSpans(text.normalize('NFC')).length > 0;
}

const hostOf = (s: string) => s.replace(/^https?:\/\//i, '').replace(/[:/?#].*$/su, '');

/**
 * A match of RE_URL that X certainly links (so counts exactly 23): a scheme URL under a listed TLD, or a domain under
 * a listed TLD — except a bare two-letter (country) domain with neither a subdomain nor a path ("kairo.ai"), which
 * twitter-text leaves as plain text.
 */
function surelyLinked(s: string): boolean {
  const host = hostOf(s);
  const labels = host.split('.');
  const tld = labels.at(-1)!.toLowerCase();
  if (!TLD_SET.has(tld)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return tld.length > 2 || labels.length > 2 || s.charAt(host.length) === '/';
}

/** What one urlSpans() span weighs at most on X: 23 for a sure link, else never less than either reading. */
function linkWeight(s: string): number {
  let sure = 0;
  let rest = 0;
  let last = 0;
  for (const [a, b] of spansOf(RE_URL, s)) {
    if (!surelyLinked(s.slice(a, b))) continue;
    rest += weigh(s.slice(last, a));
    last = b;
    sure++;
  }
  rest += weigh(s.slice(last));
  if (sure === 1 && rest === 0) return X_URL_LENGTH;
  // linked or not, by X's full TLD list: the larger of the plain weight and the linked reading
  return Math.max(weigh(s), sure * X_URL_LENGTH + rest, X_URL_LENGTH);
}

/** X's weighted length of `text` (what has to stay <= 280), never less than X's own count. */
export function xLength(text: string): number {
  const t = text.normalize('NFC');
  let n = 0;
  let last = 0;
  for (const [a, b] of urlSpans(t)) {
    n += weigh(t.slice(last, a)) + linkWeight(t.slice(a, b));
    last = b;
  }
  return n + weigh(t.slice(last));
}

const CUT_TAIL = /[\s,;:.\-–—(]+$/u;

/**
 * The longest version of `part` that keeps `build(part)` within `max`: whole when it fits, else cut at the last word
 * boundary that fits (falling back to a character cut for a single long word or text without spaces, e.g. CJK)
 * with "…" appended. null when not even "…" fits.
 */
export function fitPart(part: string, build: (p: string) => string, max = X_MAX_LENGTH): string | null {
  if (xLength(build(part)) <= max) return part;
  const fits = (p: string) => xLength(build(p)) <= max;
  const cuts: number[] = [];
  for (let i = part.length - 1; i > 0; i--) if (/\s/u.test(part[i]) && !/\s/u.test(part[i - 1])) cuts.push(i);
  for (const i of cuts) {
    const head = part.slice(0, i).replace(CUT_TAIL, '');
    if (head && fits(head + '…')) return head + '…';
  }
  const g = [...graphemes.segment(part)].map(s => s.segment);
  for (let n = g.length - 1; n > 0; n--) {
    const head = g.slice(0, n).join('').replace(CUT_TAIL, '');
    if (head && fits(head + '…')) return head + '…';
  }
  return fits('…') ? '…' : null;
}
