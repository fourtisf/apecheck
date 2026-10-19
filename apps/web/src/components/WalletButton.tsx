'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { short, type MeDTO, type NotificationDTO } from '@apecheck/core';
import { notifications as fetchNotifications, readNotifications } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { useAccount } from './Account';
import { WalletIcon } from './icons';
import { tierName, useMe } from './Me';
import { ACCOUNT_CONTROL, focusLost } from './Modal';
import { Age } from './Now';

/** "3.1M" style holding (the notes' "holds 3.1M $APECHECK"). */
export function fmtHolding(n: number): string {
  if (!(n > 0)) return '0';
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [v, s] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x >= 100 ? Math.round(x) : Number(x.toFixed(1))}${s}`;
    }
  }
  return n >= 1 ? String(Math.floor(n)) : String(Number(n.toPrecision(2)));
}

/** The account menu's first line under the tier: holding while the token is live, else when Pro and Max open. */
export function holdingLine(me: MeDTO): string | null {
  const h = me.user?.holding;
  if (me.tokenLive) return h != null ? `Holds ${fmtHolding(h)} $APECHECK` : null;
  return me.tier === 'free' ? 'Pro and Max open at token launch' : null;
}

/** Header "Connect wallet"; once signed in, the short address, the tier and the account menu. */
export function WalletButton() {
  const { me } = useMe();
  const { openWallets } = useAccount();
  const signedIn = !!me?.user;
  const was = useRef(signedIn);
  useEffect(() => {
    // signing in or out swaps this control while it (or the menu, or the wallet modal) had focus: the new one takes it
    // instead of <body> ("Connect wallet" after sign-out, the account button after sign-in). Never on page load.
    if (was.current !== signedIn && focusLost()) document.querySelector<HTMLElement>(ACCOUNT_CONTROL)?.focus();
    was.current = signedIn;
  }, [signedIn]);
  if (!me?.user) {
    return (
      <button className="btn btn-primary" type="button" onClick={() => openWallets()}>
        <WalletIcon />
        <span className="wallet-t">Connect wallet</span>
      </button>
    );
  }
  return <AccountMenu me={me} />;
}

function AccountMenu({ me }: { me: MeDTO }) {
  const user = me.user!;
  const { openWallets, signOut, linkX, unlinkX } = useAccount();
  const { setUnread } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<NotificationDTO[] | null>(null);
  const [alertsFailed, setAlertsFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // opened: focus moves into the popover (Escape brings it back to the button)
  useEffect(() => {
    if (open) menu.current?.focus();
  }, [open]);
  /** close the menu from a control inside it that is about to disappear: focus waits on the account button */
  const closeHere = () => {
    btn.current?.focus();
    setOpen(false);
  };

  const unread = me.notificationsUnread ?? 0;
  const addr = user.evmAddress ?? user.solAddress ?? '';
  const paid = me.tier !== 'free';

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetchNotifications(10);
      setAlerts(res.items);
      setAlertsFailed(false);
      setUnread(res.unread);
    } catch {
      setAlertsFailed(true);
    }
  }, [setUnread]);

  useEffect(() => {
    if (open) void loadAlerts();
  }, [open, loadAlerts]);

  // close on navigation, outside click and Escape
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openAlert = async (n: NotificationDTO) => {
    if (!n.read) {
      setAlerts(list => list?.map(x => (x.id === n.id ? { ...x, read: true } : x)) ?? list);
      readNotifications([n.id])
        .then(r => setUnread(r.unread))
        .catch(() => {});
    }
    closeHere();
    if (n.checkId) router.push(reportPath(n.checkId));
  };

  const readAll = async () => {
    setAlerts(list => list?.map(x => ({ ...x, read: true })) ?? list);
    try {
      setUnread((await readNotifications()).unread);
    } catch {
      /* the dot comes back on the next refresh */
    }
  };

  const hold = holdingLine(me);
  const label = `Account ${short(addr)}, ${tierName(me.tier)}${unread ? `, ${unread} new alert${unread === 1 ? '' : 's'}` : ''}`;

  return (
    <div className="acct" ref={wrap}>
      <button
        ref={btn}
        className="btn btn-primary acct-btn"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen(o => !o)}
      >
        <WalletIcon />
        <span className="wallet-t mono acct-addr">{short(addr)}</span>
        {paid ? <span className="acct-tier">{tierName(me.tier)}</span> : null}
        {unread ? <span className="acct-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="acct-menu" id={menuId} role="dialog" aria-label="Account" ref={menu} tabIndex={-1}>
          <div className="acct-sec acct-head">
            <div className="acct-tier-l">
              <b>{tierName(me.tier)}</b>
              <span className="muted">tier</span>
            </div>
            {hold ? <p className="acct-sub">{hold}</p> : null}
          </div>

          <div className="acct-sec">
            <h4>Wallets</h4>
            <ul className="acct-rows">
              {user.evmAddress ? (
                <li>
                  <span className="tag">EVM</span>
                  <span className="mono" title={user.evmAddress}>
                    {short(user.evmAddress)}
                  </span>
                </li>
              ) : null}
              {user.solAddress ? (
                <li>
                  <span className="tag">Solana</span>
                  <span className="mono" title={user.solAddress}>
                    {short(user.solAddress)}
                  </span>
                </li>
              ) : null}
              {user.xHandle ? (
                <li>
                  <span className="tag">X</span>
                  <span>@{user.xHandle}</span>
                  <button className="acct-link" type="button" onClick={() => void unlinkX()}>
                    Unlink
                  </button>
                </li>
              ) : null}
            </ul>
            <div className="acct-actions">
              {!user.solAddress ? (
                <button className="btn sm" type="button" onClick={() => {
                    // the wallet modal returns focus to the account button, not to this one (gone with the menu)
                    closeHere();
                    openWallets({ chain: 'sol' });
                  }}>
                  Link a Solana wallet
                </button>
              ) : null}
              {!user.evmAddress ? (
                <button className="btn sm" type="button" onClick={() => {
                    closeHere();
                    openWallets({ chain: 'evm' });
                  }}>
                  Link an EVM wallet
                </button>
              ) : null}
              {me.xLinkAvailable && !user.xHandle ? (
                <button className="btn sm" type="button" onClick={linkX}>
                  Link your X
                </button>
              ) : null}
            </div>
          </div>

          <div className="acct-sec">
            <h4>
              Re-check alerts
              {alerts?.some(a => !a.read) ? (
                <button className="acct-link" type="button" onClick={() => void readAll()}>
                  Mark all read
                </button>
              ) : null}
            </h4>
            {alerts?.length ? (
              <ul className="acct-alerts">
                {alerts.map(n => (
                  <li key={n.id}>
                    <button type="button" className={n.read ? undefined : 'unread'} onClick={() => void openAlert(n)}>
                      <span className="acct-ad" aria-hidden="true" />
                      <span className="acct-at">
                        {n.text}
                        <small>
                          <Age ts={n.createdAt} long />
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="acct-sub">
                {alertsFailed
                  ? "Couldn't load your alerts right now."
                  : alerts === null
                    ? 'Loading…'
                    : paid
                      ? "No alerts yet. Watch a project and you'll get one when its site or contract changes."
                      : me.tokenLive
                        ? 'Re-check alerts come with Pro.'
                        : 'Re-check alerts come with Pro, which opens at token launch.'}
              </p>
            )}
          </div>

          <div className="acct-sec acct-foot">
            <button className="btn sm" type="button" onClick={() => {
                closeHere();
                void signOut();
              }}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
