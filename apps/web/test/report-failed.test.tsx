/**
 * A check that stopped before a verdict: the page opens on the Agent run (the only tab that shows what happened),
 * and the Claims / Coin tabs and the price card say the run stopped instead of stating conclusions it never reached.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckReportDTO } from '@apecheck/core';
import { ClaimsTab } from '@/components/report/ClaimsTab';
import { CoinTab } from '@/components/report/CoinTab';
import { initialTab } from '@/components/report/ReportView';
import { Side } from '@/components/report/Side';
import { Verdict } from '@/components/report/Verdict';
import { noVerdict, notEnough } from '@/components/report/util';
import { report } from './fixtures';

const failedSite = report({
  id: 'revfai1',
  status: 'failed',
  narScore: null,
  total: null,
  narBand: null,
  summary: null,
  error: 'The check stopped early.',
  steps: [
    { idx: 0, t: 0, status: 'info', text: 'Opening orbitswap.xyz', source: null, url: null, caption: null, screenshot: null },
    { idx: 1, t: 4000, status: 'fail', text: 'The browser crashed', source: null, url: null, caption: null, screenshot: null },
  ] as CheckReportDTO['steps'],
});
const failedCoin = report({ ...failedSite, id: 'revfai2', kind: 'coin', name: '$ORBIT', ticker: 'ORBIT', domain: null });
const done = report({ id: 'done001', narScore: 37, total: 37 });

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('a check that stopped before a verdict', () => {
  it('opens on the Agent run tab (running checks too; finished ones on Claims)', () => {
    expect(initialTab(failedSite)).toBe('run');
    expect(initialTab({ status: 'done', narScore: null })).toBe('run');
    expect(initialTab({ status: 'running', narScore: null })).toBe('run');
    expect(initialTab(done)).toBe('claims');
    expect(noVerdict(failedSite)).toBe(true);
    expect(noVerdict(done)).toBe(false);
    expect(noVerdict({ status: 'queued', narScore: null })).toBe(false);
  });

  it('Claims says the run stopped, not that the agent found no claims', () => {
    const out = html(<ClaimsTab report={failedSite} />);
    expect(out).toContain('The check stopped before claims were tested.');
    expect(out).not.toContain('found no concrete claims');
    // a finished check without claims keeps its copy
    expect(html(<ClaimsTab report={done} />)).toContain('The agent found no concrete claims to test');
  });

  it('claims saved before the run stopped are still listed', () => {
    const r = report({
      ...failedSite,
      claims: [{ text: 'Live on Base mainnet', source: 'site_hero', sourceLabel: 'From the site hero', kind: 'mainnet', status: 'not_seen', result: 'not_seen', label: 'Not seen', signal: 'warn', evidence: 'Coming soon', stepIdx: 1 }],
    });
    expect(html(<ClaimsTab report={r} />)).toContain('Live on Base mainnet');
  });

  it('Coin tab says the run stopped before the coin, for sites and pasted contracts alike', () => {
    for (const r of [failedSite, failedCoin]) {
      const out = html(<CoinTab report={r} />);
      expect(out).toContain('The check stopped before the coin was looked at');
      expect(out).not.toContain('No coin is linked');
      expect(out).not.toContain("couldn&#x27;t be read on a supported chain");
    }
    expect(html(<CoinTab report={done} />)).toContain('No coin is linked to this site');
  });

  it('the price card says there is nothing to track, not "no coin linked, paste its contract"', () => {
    const out = html(<Side report={failedSite} />);
    expect(out).toContain('The check stopped before a verdict, so there is no price to track.');
    expect(out).not.toContain('No coin is linked');
    expect(out).not.toContain('Check a contract');
    expect(html(<Side report={done} />)).toContain('No coin is linked to this site');
  });

  it('the verdict panel: no verdict, the last fail step and "Re-check to try again"', () => {
    const out = html(<Verdict report={failedSite} just={false} />);
    expect(out).toContain('No verdict');
    expect(out).toContain('The browser crashed. Re-check to try again.');
    expect(out).not.toContain('Not enough to check');
  });
});

describe('a check that could test nothing about the project ("Not enough to check")', () => {
  const STRIDE = 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun.';
  const none = report({
    id: 'none001',
    kind: 'post',
    name: '@stridefun',
    handle: 'stridefun',
    domain: null,
    status: 'failed',
    narScore: null,
    total: null,
    narBand: null,
    summary: null,
    error: STRIDE,
    finishedAt: new Date().toISOString(),
    steps: [
      { idx: 0, t: 0, status: 'info', text: "Target is an X account: @stridefun (profiles aren't read; paste a post or the website to check more)", source: 'X', url: null, caption: null, screenshot: null },
      { idx: 1, t: 400, status: 'warn', text: 'No website found to open', source: null, url: null, caption: null, screenshot: null },
      { idx: 2, t: 900, status: 'warn', text: STRIDE, source: null, url: null, caption: null, screenshot: null },
    ] as CheckReportDTO['steps'],
  });

  it('the verdict panel names what was looked for, with no score and no "try again"', () => {
    const out = html(<Verdict report={none} just={false} />);
    expect(out).toContain('Not enough to check');
    expect(out).toContain('No website, GitHub repo or contract on a supported chain was found for @stridefun.');
    expect(out).toContain('There was nothing about the project to test, so there is no score.');
    expect(out).toContain('—');
    expect(out).not.toMatch(/try again|stopped before|No verdict|Partly real|\/100/i);
    // an outage that left nothing tested is still a run that stopped
    const outage = report({ ...none, error: "Nothing about @stridefun could be checked: GitHub didn't answer", steps: [{ ...none.steps[2], status: 'fail', text: "Nothing about @stridefun could be checked: GitHub didn't answer" }] });
    expect(notEnough(outage)).toBe(false);
    expect(html(<Verdict report={outage} just={false} />)).toContain("Nothing about @stridefun could be checked: GitHub didn&#x27;t answer. Re-check to try again.");
  });

  it('the tabs and the price card say nothing could be tested, never "stopped" or "try again"', () => {
    expect(notEnough(none)).toBe(true);
    expect(initialTab(none)).toBe('run');
    const claims = html(<ClaimsTab report={none} />);
    expect(claims).toContain('No claims were tested: there was nothing about the project to test them against.');
    const coin = html(<CoinTab report={none} />);
    expect(coin).toContain('No contract on a supported chain was found, so there is no coin score.');
    const price = html(<Side report={none} />);
    expect(price).toContain('No contract on a supported chain was found, so there is no price to track.');
    for (const out of [claims, coin, price]) expect(out).not.toMatch(/try again|stopped before/i);
  });
});
