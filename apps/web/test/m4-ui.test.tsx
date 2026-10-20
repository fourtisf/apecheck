/**
 * M4 UI without a browser: who gets the API keys and webhooks on /api and who reads the Max line, the status pills of
 * webhooks and deliveries, the webhook URL check before any request, the code tabs' real shapes, and the Coin tab's
 * wallet clusters (Pro/Max only, in the facts style).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MeDTO } from '@apecheck/core';
import { MeProvider } from '@/components/Me';
import { CodeTabs } from '@/components/pages/CodeTabs';
import {
  DevNote,
  DevTools,
  MAX_LINE,
  TEST_POLL_MAX,
  TEST_POLL_MS,
  deliveryStatus,
  devViewer,
  hookStatus,
  keyShown,
  pollStops,
  responseText,
  testPollDelay,
  webhookUrlProblem,
} from '@/components/pages/Developers';
import { ApiRequestError } from '@/lib/api';
import { CoinTab } from '@/components/report/CoinTab';
import { report } from './fixtures';

function me(o: Partial<MeDTO> = {}): MeDTO {
  return {
    credits: 5,
    max: 5,
    resetsAt: new Date().toISOString(),
    tier: 'free',
    tokenLive: false,
    proMinHold: null,
    maxMinHold: null,
    user: null,
    proChecksPerDay: 30,
    maxChecksPerDay: 200,
    token: null,
    xLinkAvailable: false,
    notificationsUnread: 0,
    ...o,
  };
}
const user = (tier: 'free' | 'pro' | 'max') => ({ id: `u-${tier}`, evmAddress: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', solAddress: null, xHandle: null, tier, holding: null, holder: tier !== 'free' });
const signedIn = (tier: 'free' | 'pro' | 'max') => me({ tier, max: tier === 'max' ? 200 : tier === 'pro' ? 30 : 5, user: user(tier) });
const html = (node: React.ReactElement, m: MeDTO | null) => renderToStaticMarkup(<MeProvider initial={m}>{node}</MeProvider>);
const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('/api: keys and webhooks are for Max', () => {
  it('devViewer: signed out, signed in below Max, Max', () => {
    expect(devViewer(null)).toBe('signed-out');
    expect(devViewer(me())).toBe('signed-out');
    expect(devViewer(signedIn('free'))).toBe('signed-in');
    expect(devViewer(signedIn('pro'))).toBe('signed-in');
    expect(devViewer(signedIn('max'))).toBe('max');
  });

  it('the line under the code: with Connect wallet signed out, alone for Free and Pro, absent for Max', () => {
    const out = html(<DevNote />, me());
    expect(text(out)).toBe(`${MAX_LINE}Connect wallet`);
    for (const tier of ['free', 'pro'] as const) expect(text(html(<DevNote />, signedIn(tier)))).toBe(MAX_LINE);
    expect(html(<DevNote />, signedIn('max'))).toBe('');
  });

  it('Max gets both sections (lists load in the browser); nobody else gets either', () => {
    const max = html(<DevTools />, signedIn('max'));
    expect(max).toContain('Your API keys');
    expect(max).toContain('Webhooks');
    expect(text(max)).toContain('count toward your 200 checks a day');
    expect(max).toContain('Loading your keys…');
    expect(max).toContain('Loading your webhooks…');
    expect(max).toContain('placeholder="https://your-server.com/apecheck"');
    expect(text(max)).toContain('check.completed');
    expect(text(max)).toContain('watch.changed');
    // check.completed is ticked by default, watch.changed is not
    expect(max).toMatch(/<input type="checkbox" checked=""\/><span class="mono">check\.completed/);
    expect(max).toMatch(/<input type="checkbox"\/><span class="mono">watch\.changed/);
    for (const m of [null, me(), signedIn('free'), signedIn('pro')]) expect(html(<DevTools />, m)).toBe('');
  });

  it('a key shows only its prefix', () => {
    expect(keyShown({ prefix: 'ak_live_Ab3x' })).toBe('ak_live_Ab3x…');
  });

  it('webhook and delivery status pills', () => {
    expect(hookStatus({ disabled: true, failCount: 20 })).toEqual({ text: 'Disabled', cls: 'fail' });
    expect(hookStatus({ disabled: false, failCount: 3 })).toEqual({ text: 'Failing', cls: 'warn' });
    expect(hookStatus({ disabled: false, failCount: 0 })).toEqual({ text: 'Active', cls: 'ok' });
    expect(deliveryStatus({ status: 'ok', attempts: 1 })).toEqual({ text: 'Delivered', cls: 'ok' });
    expect(deliveryStatus({ status: 'pending', attempts: 0 })).toEqual({ text: 'Pending', cls: 'warn' });
    expect(deliveryStatus({ status: 'pending', attempts: 2 })).toEqual({ text: 'Retrying', cls: 'warn' });
    expect(deliveryStatus({ status: 'failed', attempts: 6 })).toEqual({ text: 'Failed', cls: 'fail' });
    expect(responseText(200)).toBe('HTTP 200');
    expect(responseText(null)).toBe('No response');
  });

  it('the webhook URL is checked for shape only; the API decides https and public', () => {
    expect(webhookUrlProblem('')).toBe('Enter the URL of your endpoint.');
    expect(webhookUrlProblem('your-server.com/hook')).toBe('Enter the full URL of your endpoint, starting with https://.');
    expect(webhookUrlProblem('ftp://your-server.com/hook')).toBe('Enter the full URL of your endpoint, starting with https://.');
    expect(webhookUrlProblem(' https://your-server.com/apecheck ')).toBeNull();
    expect(webhookUrlProblem('http://127.0.0.1:4612/hook')).toBeNull();
  });
});

describe('"Send test" waits for the ping within the API limits', () => {
  /** the API's limits on GET /v1/webhooks/:id/deliveries: per IP (DEVELOPER_RATE.deliveries) and per account
   *  (USER_RATE.webhookDeliveries), both 60 a minute; and WEBHOOKS_PER_USER's default */
  const DELIVERY_READS_PER_MIN = 60;
  const WEBHOOKS_PER_USER = 5;
  const delays = Array.from({ length: TEST_POLL_MAX }, (_, n) => testPollDelay(n));
  /** when each look happens, counted from the click (the deliveries open with one read at 0) */
  const at = delays.map((_, n) => delays.slice(0, n + 1).reduce((a, b) => a + b, 0));

  it('soon at first, then less and less often, for about a minute', () => {
    expect(delays[0]).toBe(TEST_POLL_MS);
    for (let n = 1; n < delays.length; n++) expect(delays[n]).toBeGreaterThanOrEqual(delays[n - 1]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10_000);
    expect(at[at.length - 1]).toBeGreaterThanOrEqual(60_000);
    expect(at[at.length - 1]).toBeLessThanOrEqual(90_000);
  });

  it('every webhook tested at once stays under the reads the API allows in any minute', () => {
    const reads = [0, ...at];
    const most = Math.max(...reads.map(t => reads.filter(x => x >= t && x < t + 60_000).length));
    expect(most * WEBHOOKS_PER_USER).toBeLessThanOrEqual(DELIVERY_READS_PER_MIN);
  });

  it('stops after 429, 401, 403 or 404; looks past a network blip or a 5xx', () => {
    const err = (status: number, code: string) => new ApiRequestError(status, { code, error: 'x' });
    expect(pollStops(err(429, 'rate_limited'))).toBe(true);
    expect(pollStops(err(401, 'sign_in_required'))).toBe(true);
    expect(pollStops(err(403, 'max_required'))).toBe(true);
    expect(pollStops(err(404, 'not_found'))).toBe(true);
    expect(pollStops(err(0, 'network'))).toBe(false);
    expect(pollStops(err(502, 'internal'))).toBe(false);
    expect(pollStops(new Error('boom'))).toBe(false);
  });
});

describe('/api code tabs', () => {
  const out = text(renderToStaticMarkup(<CodeTabs />));

  it('REST: start with the key and JSON, then the report fields the API documents', () => {
    expect(out).toContain('-H "Authorization: Bearer $APECHECK_KEY"');
    expect(out).toContain('-H "Content-Type: application/json"');
    expect(out).toContain('# result: GET /v1/checks/8f2a91c');
    for (const k of ['"narrative": { "verdict": "PARTLY_REAL", "score": 48 }', '"coin": { "verdict": "SKETCHY", "score": 44 }', '"total": 46', '"claims": [ { "text": "Live on Base mainnet", "result": "not_seen" } ]', '"report_url": "https://apecheck.io/c/8f2a91c"']) {
      expect(out).toContain(k);
    }
  });

  it('MCP: the apecheck server at mcp.apecheck.io and its four tools', () => {
    expect(out).toContain('// ~/.cursor/mcp.json');
    expect(out).toContain('"apecheck": {');
    expect(out).toContain('"url": "https://mcp.apecheck.io"');
    for (const t of ['run_check(target)', 'get_check(id)', 'ask_followup(id, question)', 'deployer_history(wallet)']) expect(out).toContain(t);
  });

  it('Webhook: the signature is a header, the body is the WebhookPayload', () => {
    expect(out).toContain('ApeCheck-Signature: t=1792397580,v1=5c1e…');
    expect(out).not.toContain('"signature"');
    for (const k of ['"event": "check.completed"', '"created": "2026-10-19T08:13:00.000Z"', '"verdict": "PARTLY_REAL"', '"target": "orbitswap.xyz"']) expect(out).toContain(k);
    expect(out).toContain('v1 = hex HMAC-SHA256(your secret, t + "." + raw body)');
  });
});

describe('Coin tab: wallet clusters', () => {
  const coin = (clusters: { label: string; wallets: number; pct: number; fundedFrom: string | null }[] | null) =>
    report({
      kind: 'coin',
      hasCoin: true,
      coinScore: 44,
      coinBand: 'sketchy',
      coin: {
        verdict: 'SKETCHY',
        score: 44,
        sig: { deployer: 'warn', bundle: 'ok', holders: 'warn', lp: 'ok', authorities: 'ok' },
        bundlePct: null,
        bundleWallets: null,
        top10Pct: 31,
        devHoldPct: null,
        holders: 812,
        lpStatus: null,
        lpLabel: 'Unknown',
        authorities: null,
        liquidityUsd: null,
        pairCreatedAt: null,
        deployer: null,
        deployerText: null,
        clusters,
      },
    });

  it('listed in the facts style: label, share of supply, wallets, funded from (a wallet in mono)', () => {
    const out = renderToStaticMarkup(
      <CoinTab
        report={coin([
          { label: 'Launch snipers', wallets: 14, pct: 12.4, fundedFrom: '0x9a1f00000000000000000000000000000000c0de' },
          { label: 'Team wallets', wallets: 1, pct: 6.25, fundedFrom: 'Binance hot wallet' },
          { label: 'Unknown funder', wallets: 3, pct: 2, fundedFrom: null },
        ])}
      />,
    );
    const block = out.slice(out.indexOf('<div class="clusters">'));
    expect(block).toContain('<h4 class="h4">Wallet clusters <span class="lock">Pro</span></h4>');
    expect(block).toContain('<dt>Launch snipers</dt><dd>12.4% of supply<small>14 wallets, funded from <span class="mono" title="0x9a1f00000000000000000000000000000000c0de">0x9a1…c0de</span></small></dd><dd class="src">WhaleFlow</dd>');
    expect(block).toContain('<dt>Team wallets</dt><dd>6.3% of supply<small>1 wallet, funded from Binance hot wallet</small></dd>');
    expect(block).toContain('<dt>Unknown funder</dt><dd>2% of supply<small>3 wallets</small></dd>');
  });

  it('nothing when the API sent none (other viewers, or no clusters)', () => {
    for (const c of [null, []]) expect(renderToStaticMarkup(<CoinTab report={coin(c)} />)).not.toContain('Wallet clusters');
  });
});
