/**
 * M3 UI fixes without a browser: out-of-checks copy by tier, the access modal's lines, the private report's marker
 * and share card, wallet addresses in mono (no "0×") with a neutral avatar, the note counter's announcements, the
 * read-only (not disabled) ask box, the sign-in attempt that is dropped once the wallet modal closes, and the
 * deployers page built from ApeCheck's own checks.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthNonceResponse, DeployerRowDTO, MeDTO } from '@apecheck/core';
import { accessSubtitle, accessTitle } from '@/components/AccessModal';
import { CreditLine, outOfChecksText } from '@/components/feed/CreditLine';
import { MeProvider } from '@/components/Me';
import { AsksTab } from '@/components/report/AsksTab';
import { NotesTab, byLabel } from '@/components/report/NotesTab';
import { ReportHeader } from '@/components/report/ReportHeader';
import { ShareModal } from '@/components/ShareModal';
import { Tiers } from '@/components/Tiers';
import { DeployersView } from '@/components/pages/DeployersView';
import { parseDeployerFilters } from '@/components/pages/params';
import { WalletFlowError, walletSignIn, type SignInApi, type WalletOption } from '@/lib/wallet';
import { report } from './fixtures';

function me(o: Partial<MeDTO> = {}): MeDTO {
  return {
    credits: 0,
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
const user = (o: Partial<NonNullable<MeDTO['user']>> = {}) => ({ id: 'u1', evmAddress: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', solAddress: null, xHandle: null, tier: 'free' as const, holding: null, holder: false, ...o });
const html = (node: React.ReactElement, m: MeDTO | null = null) => renderToStaticMarkup(<MeProvider initial={m}>{node}</MeProvider>);

describe('out of checks', () => {
  it('only Free hears about holding; Pro and Max are told when checks come back', () => {
    expect(outOfChecksText(me({ tokenLive: true }))).toBe("You've used today's free checks. Hold $APECHECK for more, or come back after 00:00 UTC.");
    expect(outOfChecksText(me())).toBe("You've used today's free checks. Come back after 00:00 UTC.");
    for (const tier of ['pro', 'max'] as const) {
      for (const tokenLive of [true, false]) expect(outOfChecksText(me({ tier, tokenLive }))).toBe("You've used today's checks. They reset at 00:00 UTC.");
    }
    const line = html(<CreditLine />, me({ tier: 'max', max: 200, tokenLive: true, user: user({ tier: 'max', holder: true }) }));
    expect(line.replace(/&#x27;/g, "'")).toContain("You've used today's checks. They reset at 00:00 UTC.");
    expect(line).not.toContain('Hold $APECHECK');
  });

  it('the access modal: holders-get-more only for Free, Max for Pro, nothing for Max', () => {
    const pro = me({ tier: 'pro', max: 30, tokenLive: true, user: user({ tier: 'pro', holder: true }) });
    expect(accessTitle(pro, true)).toBe("You've used today's checks");
    expect(accessSubtitle(pro, true)).toBe('Checks reset at 00:00 UTC. Max gets 200 checks a day.');
    expect(accessSubtitle(me({ tier: 'max', max: 200, tokenLive: true }), true)).toBe('Checks reset at 00:00 UTC.');
    expect(accessTitle(me({ tokenLive: true }), true)).toBe("You've used today's free checks");
    expect(accessSubtitle(me({ tokenLive: true }), true)).toBe('Free checks reset at 00:00 UTC. Holders get more checks a day.');
    expect(accessSubtitle(null, true)).toBe('Free checks reset at 00:00 UTC.');
    expect(accessTitle(null, false)).toBe('Checks and access');
    expect(accessSubtitle(me({ credits: 3 }), false)).toBe('3 of 5 free checks left today. Free checks reset at 00:00 UTC.');
    // right after sign-out the count is a placeholder: left out
    expect(accessSubtitle(me({ credits: 0, max: 0 }), false, false)).toBe('Free checks reset at 00:00 UTC.');
  });

  it("a paid viewer's sign-out placeholder (max 0) never reads as a Free limit", () => {
    const out = renderToStaticMarkup(<Tiers me={me({ credits: 0, max: 0 })} onWallet={() => {}} />);
    expect(out).toContain('Free checks every day on the site');
    expect(out).not.toContain('>0 checks a day');
  });

  it('the Pro card lists only what ApeCheck itself does (no wallet clusters)', () => {
    const out = renderToStaticMarkup(<Tiers me={me()} onWallet={() => {}} />);
    expect(out).toContain('Ask follow-ups on the site and via the bot');
    expect(out).not.toMatch(/cluster|deep holder/i);
  });
});

describe('deployers page', () => {
  const row = (o: Partial<DeployerRowDTO> = {}): DeployerRowDTO => ({
    chain: 'base',
    address: '0x2222222222222222222222222222222222222222',
    checked: 2,
    real: 1,
    avgTotal: 54,
    lastChecked: new Date(Date.now() - 3 * 3600_000).toISOString(),
    coins: [{ id: 'cccc001', ticker: 'HELIX', name: '$HELIX', hue: 120, logo: null, coinScore: 61, coinBand: 'ok' }],
    ...o,
  });
  const view = (items: DeployerRowDTO[]) =>
    renderToStaticMarkup(<DeployersView initial={{ items }} initialFilters={{ chain: 'all', sort: 'real', focus: null }} />);

  it("columns from ApeCheck's own checks: wallet, chain, checked, real, avg total; no launch record", () => {
    const out = view([row()]);
    const head = out.slice(out.indexOf('<div class="tr th">'), out.indexOf('</div>', out.indexOf('<div class="tr th">')));
    expect([...head.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(m => m[1])).toEqual(['#', 'Wallet', 'Chain', 'Checked', 'Real', 'Avg total']);
    expect(out).toContain('Last checked 3h ago');
    expect(out).toContain('<span class="td num c-sc">1/2</span>');
    expect(out).toContain('Coins from this wallet checked by ApeCheck:');
    expect(out).toContain('Every wallet that deployed a coin ApeCheck has checked, and how its checked coins scored. Only coins checked on ApeCheck are counted.');
    expect(out).not.toMatch(/launched|dead|funded|serial|builder|mixed record|devradar/i);
  });

  it('sorts by what ApeCheck knows; chains are the ones whose deployer it looks up; old sort links still open', () => {
    const out = view([row()]);
    const options = [...out.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);
    expect(options).toEqual([
      ['real', 'Most real first'],
      ['checked', 'Most checked coins first'],
      ['recent', 'Recently checked first'],
    ]);
    const chains = [...out.slice(out.indexOf('id="dChain"')).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]).slice(0, 8);
    expect(chains).toEqual(['All chains', 'Ethereum', 'Base', 'BNB', 'Arbitrum', 'Robinhood', 'Tron']);
    for (const sort of ['dead', 'launched']) expect(parseDeployerFilters(new URLSearchParams(`sort=${sort}`)).sort).toBe('checked');
    expect(parseDeployerFilters(new URLSearchParams('sort=recent')).sort).toBe('recent');
    expect(parseDeployerFilters(new URLSearchParams('sort=nope')).sort).toBe('real');
  });
});

describe('private report', () => {
  it('is marked Private in the meta line', () => {
    const priv = html(<ReportHeader report={report({ id: 'priv001', isPrivate: true })} />);
    expect(priv).toMatch(/<span class="lock" title="Only you can see this check">Private<\/span>/);
    expect(html(<ReportHeader report={report({ id: 'pub0001' })} />)).not.toContain('>Private<');
  });

  it('its share card can be downloaded but not posted (the link opens only for its owner)', () => {
    const r = report({ id: 'priv001', isPrivate: true });
    expect(html(<ShareModal item={r} postable={false} />)).not.toContain('Post to X');
    expect(html(<ShareModal item={r} postable={false} />)).toContain('Download image');
    expect(html(<ShareModal item={r} />)).toContain('Post to X');
  });
});

describe('wallet addresses', () => {
  it('are set in mono (the body font draws "0x" as "0×"); handles and "holder" stay plain', () => {
    expect(renderToStaticMarkup(<>{byLabel('0x19e…ff2a')}</>)).toBe('<span class="mono">0x19e…ff2a</span>');
    expect(renderToStaticMarkup(<>{byLabel('7xKX…sAsU')}</>)).toBe('<span class="mono">7xKX…sAsU</span>');
    expect(renderToStaticMarkup(<>{byLabel('@solsleuth')}</>)).toBe('@solsleuth');
    expect(renderToStaticMarkup(<>{byLabel('kairo')}</>)).toBe('@kairo');
    expect(renderToStaticMarkup(<>{byLabel('holder')}</>)).toBe('holder');
  });

  it('a wallet-only asker gets the wallet icon, not a "0" avatar; a handle keeps its letter', () => {
    const asks = [
      { id: 'a1', question: 'Is the liquidity locked?', answer: 'Not that the check could see.', by: '0x19e…ff2a', via: 'site' as const, createdAt: new Date().toISOString() },
      { id: 'a2', question: 'Who deployed it?', answer: 'A fresh wallet.', by: 'solsleuth', via: 'x' as const, createdAt: new Date().toISOString() },
    ];
    const out = html(<AsksTab checkId="c1" list={asks} count={2} onAsked={() => {}} />);
    const avatars = [...out.matchAll(/<div class="q"><span class="mini-av">([\s\S]*?)<\/span><div>/g)].map(m => m[1]);
    expect(avatars[0]).toContain('<svg');
    expect(avatars[1]).toBe('S');
    expect(out).toContain('<b><span class="mono">0x19e…ff2a</span></b> asked on the site');
    expect(out).toContain('<b>@solsleuth</b> asked via X');
  });

  it('a note by a wallet-only author', () => {
    const notes = [{ id: 'n1', by: '0x19e…ff2a', hold: null, text: 'Same template as last week.', helpful: 0, mine: false, createdAt: new Date().toISOString() }];
    expect(html(<NotesTab checkId="c1" list={notes} onChange={() => {}} />)).toContain('<b><span class="mono">0x19e…ff2a</span></b>');
  });
});

describe('forms keep focus while they wait', () => {
  it('the ask box is never disabled (a disabled field drops focus to <body>)', () => {
    const out = html(<AsksTab checkId="c1" list={[]} count={0} onAsked={() => {}} />);
    expect(out).toMatch(/<input[^>]*aria-label="Ask a follow-up"/);
    expect(out).not.toMatch(/<input[^>]*disabled/);
  });

  it("the note counter is read with the field, not announced on every keystroke", () => {
    const holder = me({ tokenLive: true, user: user({ holder: true, holding: 1000 }) });
    const out = html(<NotesTab checkId="c1" list={[]} onChange={() => {}} />, holder);
    expect(out).toMatch(/<textarea[^>]*aria-describedby="noteCount"/);
    expect(out).toMatch(/<span id="noteCount" class="note-n">0\/500<\/span>/);
    expect(out).not.toMatch(/<textarea[^>]*disabled/);
  });
});

describe('a sign-in attempt the visitor gave up on', () => {
  function wallet(connect: () => Promise<{ address: string; chainId: number | null }>, signMessage = vi.fn(async () => '0x' + 'ab'.repeat(65))): WalletOption {
    return { key: 'evm:test', name: 'Test', icon: null, chain: 'evm', via: 'eip6963', connect, signMessage } as unknown as WalletOption;
  }
  const api = () => {
    const nonce = vi.fn(async (): Promise<AuthNonceResponse> => ({ nonce: 'n', message: 'msg', expiresAt: new Date().toISOString() }) as AuthNonceResponse);
    const verify = vi.fn(async () => me({ user: user() }));
    return { nonce, verify, api: { nonce, verify } as SignInApi };
  };

  it('a wallet that answers after the modal closed gets no nonce, no signature request and no sign-in', async () => {
    let answer!: (a: { address: string; chainId: number | null }) => void;
    const opt = wallet(() => new Promise(r => (answer = r)));
    const { nonce, verify, api: a } = api();
    let live = true;
    const run = walletSignIn(opt, a, undefined, () => live);
    live = false; // the visitor closed the wallet modal
    answer({ address: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', chainId: 1 });
    const err = await run.catch(e => e);
    expect(err).toBeInstanceOf(WalletFlowError);
    expect(err.code).toBe('cancelled');
    expect(nonce).not.toHaveBeenCalled();
    expect(opt.signMessage).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('a signature that lands after the modal closed is never sent to verify', async () => {
    let signed!: (s: string) => void;
    const opt = wallet(async () => ({ address: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', chainId: 1 }), vi.fn(() => new Promise<string>(r => (signed = r))));
    const { verify, api: a } = api();
    let live = true;
    const run = walletSignIn(opt, a, undefined, () => live);
    await vi.waitFor(() => expect(opt.signMessage).toHaveBeenCalled());
    live = false;
    signed('0x' + 'cd'.repeat(65));
    expect((await run.catch(e => e)).code).toBe('cancelled');
    expect(verify).not.toHaveBeenCalled();
  });
});
