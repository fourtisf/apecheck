/**
 * A coin on a chain ApeCheck can't read (CheckSummaryDTO.otherChain, from Check.evidence.otherChain): a pasted Sonic
 * contract whose check moved to the website in its token info, or one a post or page named. The report and the feed
 * say the coin wasn't checked; never "No coin linked" or "paste the contract" (the viewer may have pasted it).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { otherChainCoinText } from '@apecheck/core';
import { VerdictCard } from '@/components/VerdictCard';
import { VerdictRow } from '@/components/VerdictRow';
import { CoinTab } from '@/components/report/CoinTab';
import { Side } from '@/components/report/Side';
import { Verdict } from '@/components/report/Verdict';
import { report, summary } from './fixtures';

const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
const TEXT = "Coin on Sonic: not checked (ApeCheck can't read that chain yet)";
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const esc = (s: string) => s.replace(/'/g, '&#x27;');

// the check moved to esco.example (kind site), and a pasted contract with no website in its token info (kind coin)
const moved = report({ id: 'sonic01', kind: 'site', name: 'esco.example', domain: 'esco.example', narScore: 64, total: 64, narBand: 'likely', otherChain: { chain: 'Sonic', address: SONIC } });
const stayed = report({ id: 'sonic02', kind: 'coin', name: '$ESCO', ticker: 'ESCO', domain: null, ca: SONIC, narScore: 30, total: 30, narBand: 'llarp', otherChain: { chain: 'Sonic', address: SONIC } });
const plain = report({ id: 'plain01', narScore: 37, total: 37 });

describe("a coin on a chain ApeCheck can't read", () => {
  it('the shared sentence', () => {
    expect(otherChainCoinText('Sonic')).toBe(TEXT);
  });

  it('verdict panel: the coin meter names the chain, not "No coin linked" or "couldn\'t be scored"', () => {
    for (const r of [moved, stayed]) {
      const out = html(<Verdict report={r} just={false} />);
      expect(out).toContain(esc(TEXT));
      expect(out).not.toContain('No coin linked');
      expect(out).not.toContain(esc("The coin couldn't be scored"));
    }
    expect(html(<Verdict report={plain} just={false} />)).toContain('No coin linked to this site');
  });

  it('Coin tab: not checked, with the contract; no "paste the contract" and no "Check a contract" button', () => {
    for (const r of [moved, stayed]) {
      const out = html(<CoinTab report={r} />);
      expect(out).toContain(esc(`${TEXT}, so this check has no coin facts and no coin score.`));
      expect(out).toContain(`title="${SONIC}"`);
      expect(out).toContain('0x17c…d1fc');
      expect(out).not.toContain('No coin is linked');
      expect(out).not.toContain('paste the contract');
      expect(out).not.toContain('Check a contract');
      expect(out).not.toContain(esc("couldn't be read on a supported chain"));
    }
  });

  it('price card: no price to track because the coin wasn\'t checked; no call to paste the contract', () => {
    for (const r of [moved, stayed]) {
      const out = html(<Side report={r} />);
      expect(out).toContain(esc(`${TEXT}, so there is no price to track.`));
      expect(out).not.toContain('No coin is linked');
      expect(out).not.toContain('paste its contract');
      expect(out).not.toContain('Check a contract');
    }
    expect(html(<Side report={plain} />)).toContain('No coin is linked to this site');
  });

  it('feed row and grid card: "Coin on Sonic: not checked" (the full sentence on hover), never "No coin linked" / "No coin"', () => {
    const item = summary({ id: 'sonic01', name: 'esco.example', domain: 'esco.example', otherChain: { chain: 'Sonic', address: SONIC } });
    const row = html(<VerdictRow item={item} />);
    expect(row).toContain(`title="${esc(TEXT)}"`);
    expect(row).toContain('>Coin on Sonic: not checked<');
    expect(row).not.toContain('No coin linked');
    const card = html(<VerdictCard item={item} />);
    expect(card).toContain(`title="${esc(TEXT)}"`);
    expect(card).toContain('MC —');
    expect(card).not.toMatch(/>No coin</);
    // without otherChain the feed keeps its copy
    expect(html(<VerdictRow item={summary()} />)).toContain('No coin linked');
    expect(html(<VerdictCard item={summary()} />)).toContain('>No coin<');
  });
});
