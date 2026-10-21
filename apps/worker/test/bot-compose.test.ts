/**
 * composeReply() and X's character counting (HANDOFF §7 reply format, max 280 counted the way X counts). Pure.
 */
import { describe, expect, it } from 'vitest';
import { BOT_DISCLAIMER } from '@apecheck/core';
import {
  FAILED_TEXT,
  NOT_ENOUGH_TEXT,
  NO_ANSWER_TEXT,
  PRO_POINTER_TEXT,
  composeFollowUp,
  composePointer,
  composeReply,
  fitsX,
  onlyReportLink,
  reportLink,
  sanitizeModelText,
  stripLinks,
  stripMentions,
  type ReplyCheck,
} from '../src/bot/compose';
import { X_URL_LENGTH, fitPart, hasLink, urlSpans, xLength } from '../src/bot/xtext';

const OFF = { includeLink: false, appUrl: 'https://apecheck.io' };
const ON = { includeLink: true, appUrl: 'https://apecheck.io' };

const spansOf = (t: string) => urlSpans(t.normalize('NFC')).map(([a, b]) => t.normalize('NFC').slice(a, b));

const check = (p: Partial<ReplyCheck> = {}): ReplyCheck => ({
  status: 'DONE',
  shortId: 'k3x9a2q',
  narScore: 37,
  narBand: 'llarp',
  coinScore: 37,
  coinBand: 'sketchy',
  summary: "'Launch app' does nothing; GitHub pushed in one burst at launch.",
  ...p,
});

describe('xLength (X weighted length)', () => {
  it('counts Latin text, punctuation and the general-punctuation block as 1', () => {
    expect(xLength('hello world')).toBe(11);
    expect(xLength('LIKELY LARP (37/100) · Coin')).toBe(27);
    expect(xLength('a — b ‘c’ “d”')).toBe(13);
  });

  it('counts CJK and other wide scripts as 2, and "…" as 2', () => {
    expect(xLength('这是真的吗')).toBe(10);
    expect(xLength('日本語abc')).toBe(9);
    expect(xLength('…')).toBe(2);
    expect(xLength('한국어')).toBe(6);
  });

  it('counts every emoji as 2, however many code points it has', () => {
    expect(xLength('🚀')).toBe(2);
    expect(xLength('👨‍👩‍👧‍👦')).toBe(2); // ZWJ family: 7 code points
    expect(xLength('🇺🇸')).toBe(2); // flag
    expect(xLength('👍🏽')).toBe(2); // skin tone
    expect(xLength('1️⃣')).toBe(2); // keycap
    expect(xLength('gm 🚀🚀')).toBe(7);
  });

  it('counts every URL as 23, with or without a scheme, short or long', () => {
    expect(xLength('apecheck.io/c/k3x9a2q')).toBe(X_URL_LENGTH);
    expect(xLength('https://apecheck.io/c/k3x9a2q')).toBe(X_URL_LENGTH);
    expect(xLength(`see https://example.com/${'a'.repeat(120)}`)).toBe(4 + X_URL_LENGTH);
    expect(xLength('x.co')).toBe(X_URL_LENGTH);
    expect(xLength('end apecheck.io.')).toBe(4 + X_URL_LENGTH + 1); // trailing dot is not part of the URL
    expect(xLength('@apecheck.io')).toBe(12); // not linked after "@"
    expect(xLength('v1.5 e.g. i.e. U.S.')).toBe(19); // not URLs
    // a dotted name whose last part could be a TLD counts as a possible link: an upper bound, never short
    expect(xLength('v1.5 e.g. node.js')).toBe(10 + X_URL_LENGTH);
  });

  it('is an upper bound for domains under TLDs it does not list (X links every gTLD)', () => {
    expect(xLength('a.ninja b.pizza')).toBe(X_URL_LENGTH + 1 + X_URL_LENGTH);
    for (const u of ['jup.ag/swap', 'station.jup.ag', 'app.orbit.market', 'docs.orbit.team', 'claim.ninja', 'kairo.ai']) {
      expect(xLength(u), u).toBeGreaterThanOrEqual(X_URL_LENGTH);
    }
    // X leaves a bare country domain without a path plain: then it counts its own (longer) length
    expect(xLength('averyveryverylongprojectname.io')).toBe(31);
    // X links the listed part and counts the rest as text
    expect(xLength('orbit.xyz.foo')).toBe(X_URL_LENGTH + 4);
    expect(xLength('日本.example.com')).toBe(5 + X_URL_LENGTH);
    expect(xLength('orbit.xyz上线了')).toBe(X_URL_LENGTH + 6);
    // a scheme URL under an unknown TLD: never less than its own length
    const long = `https://claim.ninja/${'a'.repeat(40)}`;
    expect(xLength(long)).toBe(long.length);
    // a CJK character ends a URL's path
    expect(xLength('https://a.ninja/日本語')).toBe(X_URL_LENGTH + 6);
    expect(hasLink('see orbit[.]xyz')).toBe(false);
    expect(hasLink('see orbit.xyz')).toBe(true);
  });

  it('normalises to NFC first', () => {
    expect(xLength('é')).toBe(1);
  });
});

describe('composeReply', () => {
  it('matches the HANDOFF format', () => {
    expect(composeReply(check(), OFF)).toBe(
      "LIKELY LARP (37/100) · Coin: SKETCHY (37)\n'Launch app' does nothing; GitHub pushed in one burst at launch.\nChecks the claims, not the team. DYOR.",
    );
  });

  it('leaves the coin part out without a coin', () => {
    expect(composeReply(check({ narScore: 82, narBand: 'real', coinScore: null, coinBand: null, summary: 'The app works end to end.' }), OFF)).toBe(
      `REAL (82/100)\nThe app works end to end.\n${BOT_DISCLAIMER}`,
    );
  });

  it('derives a missing band from the score, and drops an empty summary line', () => {
    expect(composeReply(check({ narBand: null, narScore: 64, coinBand: null, coinScore: 20, summary: '   ' }), OFF)).toBe(
      `LIKELY REAL (64/100) · Coin: RIGGED (20)\n${BOT_DISCLAIMER}`,
    );
  });

  describe("a coin on a chain ApeCheck can't read (evidence.otherChain)", () => {
    const site = check({ narScore: 64, narBand: 'likely', coinScore: null, coinBand: null, summary: 'The app loads and the swap reaches a transaction.', otherChain: { chain: 'Sonic', site: 'esco.example' } });

    it('one fixed line under the verdict: the verdict is for the site from the token info (never a link), the coin was not checked', () => {
      expect(composeReply(site, OFF)).toBe(
        "LIKELY REAL (64/100)\nThis verdict is for esco[.]example, the website in the token's info; the coin on Sonic wasn't checked.\n" +
          `The app loads and the swap reaches a transaction.\n${BOT_DISCLAIMER}`,
      );
      expect(spansOf(composeReply(site, OFF))).toEqual([]);
      expect(spansOf(composeReply(site, ON))).toEqual(['apecheck.io/c/k3x9a2q']);
    });

    it('a check that stayed on the contract (no website) or a post: only that the coin was not checked', () => {
      const t = composeReply(check({ coinScore: null, coinBand: null, otherChain: { chain: 'Sonic', site: null } }), OFF);
      expect(t.split('\n')[1]).toBe("The coin on Sonic wasn't checked: ApeCheck can't read that chain yet.");
      // a site name too long to fit is left out, never the line
      const long = composeReply(check({ coinScore: null, coinBand: null, otherChain: { chain: 'Sonic', site: `${'a'.repeat(70)}.example` } }), OFF);
      expect(long.split('\n')[1]).toBe("This verdict is for the website in the token's info; the coin on Sonic wasn't checked.");
    });

    it('stays within 280 (fitsX) with the longest names, a coin in the head and a long summary: the summary is what gets cut', () => {
      // the longest site (60 characters defanged) and chain (24, DexScreener's longest id) names that are still named
      const longest = { chain: 'Abcdefghijk Lmnopqrstuvw', site: `${'a'.repeat(50)}.example` };
      const line = composeReply(check({ coinScore: null, coinBand: null, otherChain: longest }), OFF).split('\n')[1];
      expect(line).toBe(`This verdict is for ${'a'.repeat(50)}[.]example, the website in the token's info; the coin on Abcdefghijk Lmnopqrstuvw wasn't checked.`);
      expect(line).toHaveLength(167);
      // a longer chain name is not spelled out
      expect(composeReply(check({ otherChain: { chain: 'A'.repeat(25), site: null } }), OFF).split('\n')[1]).toBe(
        "The coin on another chain wasn't checked: ApeCheck can't read that chain yet.",
      );
      const summary = 'The app loads but the main flow stops at a waitlist page '.repeat(8).trim();
      for (const opts of [OFF, ON]) {
        for (const otherChain of [site.otherChain!, longest, { chain: 'Sonic', site: null }]) {
          // the widest head there is: "PARTLY REAL (100/100) · Coin: SKETCHY (100)"
          for (const scores of [{ coinScore: null, coinBand: null }, { narScore: 100, narBand: 'partly', coinScore: 100, coinBand: 'sketchy' }]) {
            const t = composeReply(check({ narScore: 37, narBand: 'llarp', summary, otherChain, ...scores }), opts);
            expect(fitsX(t)).toBe(true);
            expect(xLength(t)).toBeLessThanOrEqual(280);
            const lines = t.split('\n');
            expect(lines[1]).toMatch(/wasn't checked/);
            expect(lines.at(opts.includeLink ? -2 : -1)).toBe(BOT_DISCLAIMER);
            expect(spansOf(t)).toEqual(opts.includeLink ? ['apecheck.io/c/k3x9a2q'] : []);
            if (otherChain !== longest || !scores.coinScore) expect(lines[2].endsWith('…')).toBe(true);
          }
        }
      }
    });

    it('without otherChain the reply is unchanged', () => {
      expect(composeReply(check({ otherChain: null }), OFF)).toBe(composeReply(check(), OFF));
    });
  });

  it('says a failed check could not finish', () => {
    expect(composeReply(check({ status: 'FAILED' }), OFF)).toBe(FAILED_TEXT);
    expect(composeReply(check({ status: 'FAILED' }), ON)).toBe("Couldn't finish this check. Try again in a few minutes.");
    expect(composeReply(check({ narScore: null }), OFF)).toBe(FAILED_TEXT);
    // an outage that left nothing tested is still "couldn't finish", never "not enough"
    expect(composeReply(check({ status: 'FAILED', error: "Nothing about @stridefun could be checked: GitHub didn't answer" }), OFF)).toBe(FAILED_TEXT);
  });

  it('a check that could test nothing about the project: its reason, never "try again" or a score', () => {
    const failed = (error: string) => check({ status: 'FAILED', narScore: null, narBand: null, coinScore: null, coinBand: null, summary: null, error });
    // the incidents: an X profile with no links, and a contract on a chain ApeCheck doesn't support
    const stride = failed('Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun.');
    expect(composeReply(stride, OFF)).toBe('Not enough to check: no website, GitHub repo or contract on a supported chain was found for stridefun.');
    expect(composeReply(stride, ON)).toBe('Not enough to check: no website, GitHub repo or contract on a supported chain was found for stridefun.\napecheck.io/c/k3x9a2q');
    const esco = failed('Not enough to check: 0x17c…d1fc is not on Base, Ethereum, BNB Chain or Arbitrum, and no website or GitHub repo was found for it.');
    expect(composeReply(esco, OFF)).toBe(esco.error);
    // a site the reason names is not a link in the reply (nobody is mentioned, nothing but the report link is linked)
    const site = composeReply(failed("Not enough to check: orbitswap.xyz didn't load, and no GitHub repo or contract on a supported chain was found for it."), ON);
    expect(site).toBe("Not enough to check: orbitswap[.]xyz didn't load, and no GitHub repo or contract on a supported chain was found for it.\napecheck.io/c/k3x9a2q");
    expect(onlyReportLink(site, 'apecheck.io/c/k3x9a2q')).toBe(true);
    for (const t of [composeReply(stride, ON), composeReply(esco, ON), site]) {
      expect(t).not.toMatch(/try again|\/100|PARTLY|@/i);
      expect(xLength(t)).toBeLessThanOrEqual(280);
    }
    // a reason with nothing after the prefix: the general line
    expect(composeReply(failed('Not enough to check: '), OFF)).toBe(NOT_ENOUGH_TEXT);
    expect(composeReply(failed('Not enough to check: @'), ON)).toBe(`${NOT_ENOUGH_TEXT}\napecheck.io/c/k3x9a2q`);
  });

  it('appends the report link only with BOT_INCLUDE_LINK, on the APP_URL host', () => {
    expect(composeReply(check(), ON).split('\n').at(-1)).toBe('apecheck.io/c/k3x9a2q');
    expect(composeReply(check(), OFF)).not.toMatch(/apecheck\.io/);
    expect(reportLink('http://localhost:3000', 'abc1234')).toBe('localhost:3000/c/abc1234');
    expect(reportLink('not a url', 'abc1234')).toBe('apecheck.io/c/abc1234');
  });

  it('cuts a long summary at a word boundary with "…" to stay within 280', () => {
    const long = 'The app loads but the main flow stops at a waitlist page '.repeat(8).trim();
    for (const opts of [OFF, ON]) {
      const text = composeReply(check({ summary: long }), opts);
      expect(xLength(text)).toBeLessThanOrEqual(280);
      expect(xLength(text)).toBeGreaterThan(260);
      const summary = text.split('\n')[1];
      expect(summary.endsWith('…')).toBe(true);
      expect(long.startsWith(summary.slice(0, -1))).toBe(true);
      // the cut is between words
      expect(long[summary.length - 1]).toBe(' ');
      expect(text.split('\n')[2]).toBe(BOT_DISCLAIMER);
    }
  });

  it('counts emoji and CJK the X way when cutting', () => {
    const cjk = '这个项目的应用可以打开但主要流程停在即将推出页面'.repeat(10);
    const t1 = composeReply(check({ summary: cjk }), ON);
    expect(xLength(t1)).toBeLessThanOrEqual(280);
    expect(t1.split('\n')[1].endsWith('…')).toBe(true);
    expect(t1.length).toBeLessThan(200); // JS length would allow far more: each CJK char counts 2

    const emoji = Array.from({ length: 200 }, () => '🚀').join(' ');
    const t2 = composeReply(check({ summary: emoji }), OFF);
    expect(xLength(t2)).toBeLessThanOrEqual(280);
    expect(xLength(t2)).toBeGreaterThan(270);
  });

  it('never mentions anyone: @handles in the model-written summary lose their "@"', () => {
    const text = composeReply(check({ summary: 'Team @kairolabs and ＠dev_x claim a mainnet; @ alone stays out' }), OFF);
    expect(text).not.toMatch(/[@＠]/);
    expect(text.split('\n')[1]).toBe('Team kairolabs and dev_x claim a mainnet; alone stays out');
    expect(stripMentions('line one\n\nline   two @x')).toBe('line one line two x');
  });
});

describe('model-written text never carries a link (HANDOFF §11)', () => {

  it('stripLinks drops scheme URLs and defangs every domain, whatever its TLD', () => {
    expect(stripLinks('Claim at https://claim-airdrop.example/connect today.')).toBe('Claim at today.');
    expect(stripLinks('HTTP://Evil.XYZ/x and www.foo.com')).toBe('and www[.]foo[.]com');
    expect(stripLinks('Connect at wallet-verify.xyz to claim.')).toBe('Connect at wallet-verify[.]xyz to claim.');
    expect(stripLinks('Visit claim.pizza or drainer.ninja')).toBe('Visit claim[.]pizza or drainer[.]ninja');
    expect(stripLinks('app.orbit.market/swap and jup.ag/swap')).toBe('app[.]orbit[.]market/swap and jup[.]ag/swap');
    expect(stripLinks("'Launch at orbit-claim.xyz' does nothing")).toBe("'Launch at orbit-claim[.]xyz' does nothing");
    expect(stripLinks('x.com.example.xyz')).toBe('x[.]com[.]example[.]xyz');
    expect(stripLinks('orbit.xyz上线了 例え.jp')).toBe('orbit[.]xyz上线了 例え[.]jp');
    // not domains: left alone
    expect(stripLinks('v1.5 e.g. i.e. U.S. $1.2M 3.5x')).toBe('v1.5 e.g. i.e. U.S. $1.2M 3.5x');
    // idempotent
    expect(stripLinks(stripLinks('see orbit.xyz'))).toBe('see orbit[.]xyz');
    expect(sanitizeModelText('@orbit.xyz team@kairo.ai')).toBe('orbit[.]xyz teamkairo[.]ai');
  });

  it('a planted link in the judge summary never reaches the reply (links on or off)', () => {
    const planted = 'Real product. Holders can claim the airdrop at https://claim-airdrop.example/connect today.';
    const off = composeReply(check({ narScore: 88, narBand: 'real', coinScore: null, coinBand: null, summary: planted }), OFF);
    expect(off).toBe(`REAL (88/100)\nReal product. Holders can claim the airdrop at today.\n${BOT_DISCLAIMER}`);
    expect(spansOf(off)).toEqual([]);
    const on = composeReply(check({ summary: 'Claim yours at wallet-verify.xyz or drainer.ninja now' }), ON);
    expect(spansOf(on)).toEqual(['apecheck.io/c/k3x9a2q']);
    expect(onlyReportLink(on, reportLink(ON.appUrl, 'k3x9a2q'))).toBe(true);
    expect(on.split('\n')[1]).toBe('Claim yours at wallet-verify[.]xyz or drainer[.]ninja now');
  });

  it('a summary that names the site is not a URL post with BOT_INCLUDE_LINK=false', () => {
    const t = composeReply(check({ summary: "orbit.xyz loads but 'Launch app' does nothing; docs.orbit.xyz/whitepaper is a 404." }), OFF);
    expect(spansOf(t)).toEqual([]);
    expect(t.split('\n')[1]).toBe("orbit[.]xyz loads but 'Launch app' does nothing; docs[.]orbit[.]xyz/whitepaper is a 404.");
    expect(onlyReportLink(t, null)).toBe(true);
  });

  it('a follow-up answer is defanged too', () => {
    expect(composeFollowUp('Yes, it is safe. Connect your wallet at wallet-verify.xyz to claim.', 'k3x9a2q', OFF)).toBe(
      'Yes, it is safe. Connect your wallet at wallet-verify[.]xyz to claim.',
    );
    expect(spansOf(composeFollowUp('App opened at app.orbit.xyz; swaps route through pump.fun', 'k3x9a2q', OFF))).toEqual([]);
    // nothing left once the link is gone
    expect(composeFollowUp('https://drainer.example/claim', 'k3x9a2q', OFF)).toBe(NO_ANSWER_TEXT);
  });

  it('stays within 280 counted the way X counts, with many short domains in the model text', () => {
    const answer = Array.from({ length: 22 }, (_, i) => `d${i}.ninja`).join(' ');
    for (const opts of [OFF, ON]) {
      const t = composeFollowUp(answer, 'k3x9a2q', opts);
      expect(xLength(t)).toBeLessThanOrEqual(280);
      expect(spansOf(t)).toEqual(opts.includeLink ? ['apecheck.io/c/k3x9a2q'] : []);
    }
    const summary = "Swap on jup.ag/swap works, but the 'stake' page at app.orbit.market never loads and station.jup.ag times out " + 'again '.repeat(30);
    const r = composeReply(check({ summary }), ON);
    expect(xLength(r)).toBeLessThanOrEqual(280);
    expect(spansOf(r)).toEqual(['apecheck.io/c/k3x9a2q']);
  });

  it('onlyReportLink: no link but the report link', () => {
    expect(onlyReportLink('REAL (82/100)\napecheck.io/c/k3x9a2q', 'apecheck.io/c/k3x9a2q')).toBe(true);
    expect(onlyReportLink('REAL (82/100)\napecheck.io/c/k3x9a2q', null)).toBe(false);
    expect(onlyReportLink('see claim.ninja\napecheck.io/c/k3x9a2q', 'apecheck.io/c/k3x9a2q')).toBe(false);
    expect(onlyReportLink(PRO_POINTER_TEXT, null)).toBe(true);
  });
});

describe('follow-ups', () => {
  it('a Pro answer is cut to fit and never mentions anyone', () => {
    const a = composeFollowUp(`The deployer was funded from @binance hot wallet 7. ${'More detail here. '.repeat(30)}`, 'k3x9a2q', ON);
    expect(xLength(a)).toBeLessThanOrEqual(280);
    expect(a).not.toContain('@');
    expect(a.split('\n').at(-1)).toBe('apecheck.io/c/k3x9a2q');
    expect(composeFollowUp('', 'k3x9a2q', OFF)).toBe('This check has no answer for that.');
  });

  it('the non-Pro pointer is one line, with the link only when links are on', () => {
    expect(composePointer('k3x9a2q', OFF)).toBe(PRO_POINTER_TEXT);
    expect(composePointer('k3x9a2q', OFF)).not.toMatch(/\.io|https?:/);
    expect(composePointer('k3x9a2q', ON)).toBe(`${PRO_POINTER_TEXT}\napecheck.io/c/k3x9a2q`);
  });
});

describe('fitPart', () => {
  it('falls back to a character cut for one long word, and gives up when nothing fits', () => {
    const word = 'a'.repeat(400);
    const cut = fitPart(word, p => p, 280)!;
    expect(cut.endsWith('…')).toBe(true);
    expect(xLength(cut)).toBe(280);
    expect(fitPart('anything', p => 'x'.repeat(280) + p, 280)).toBeNull();
  });
});
