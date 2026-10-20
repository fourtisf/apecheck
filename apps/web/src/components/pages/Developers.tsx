'use client';
/**
 * The /api page wired to real keys (M4, Max; HANDOFF §9 and §13 M4).
 *
 * - `DevNote`: the line under the code card for everyone who isn't Max ("API keys, webhooks and MCP are part of Max."),
 *   with Connect wallet when signed out.
 * - `DevTools`: for a signed-in Max viewer, "Your API keys" and "Webhooks" under the docs. Both are managed with the
 *   wallet session (the API refuses API keys on these routes). A new key and a new webhook's signing secret are shown
 *   once, in a copyable field, and never again: the API stores only the key's hash and the list shows its prefix.
 */
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiKeyDTO, MeDTO, WebhookDTO, WebhookDeliveryDTO, WebhookEvent } from '@apecheck/core';
import {
  apiKeys,
  createApiKey,
  createWebhook,
  deleteWebhook,
  enableWebhook,
  isAbortError,
  isApiError,
  revokeApiKey,
  testWebhook,
  webhookDeliveries,
  webhooks,
  type ApiRequestError,
} from '@/lib/api';
import { reportPath } from '@/lib/env';
import { useAccount } from '../Account';
import { CopyIcon } from '../icons';
import { useMe } from '../Me';
import { Age } from '../Now';
import { useToast } from '../Toast';

/* ---------------- pure rules (unit-tested) ---------------- */

export const MAX_LINE = 'API keys, webhooks and MCP are part of Max.';
/** the API's limit on key names (apps/api KEY_NAME_MAX) */
export const KEY_NAME_MAX = 40;
/**
 * How "Send test" looks for the ping's result: soon at first (the worker usually delivers within a second or two),
 * then less and less often, for about a minute in all. Every look is a read of the deliveries, which the API limits per
 * IP and per account (60 a minute): even with every webhook (WEBHOOKS_PER_USER, 5) tested at once, a minute of looking
 * stays under that.
 */
export const TEST_POLL_MS = 1500;
export const TEST_POLL_CAP_MS = 10_000;
export const TEST_POLL_MAX = 10;
/** the wait before look `n` (0-based): 1.5 s twice, 3 s twice, 6 s twice, then 10 s */
export const testPollDelay = (n: number) => Math.min(TEST_POLL_MS * 2 ** Math.floor(Math.max(0, n) / 2), TEST_POLL_CAP_MS);

/**
 * After a failed look, is another one pointless? Yes after 429 (it would only add to the count and lock the panel
 * longer), 401/403 (signed out or no longer Max) and 404 (the webhook was deleted elsewhere). A network blip or a 5xx
 * is looked past.
 */
export function pollStops(e: unknown): boolean {
  return isApiError(e) && (e.status === 429 || e.status === 401 || e.status === 403 || e.status === 404);
}

export type DevViewer = 'max' | 'signed-in' | 'signed-out';

/** Who is looking: a signed-in Max viewer gets the keys and webhooks; everyone else the line under the code. */
export function devViewer(me: MeDTO | null): DevViewer {
  if (!me?.user) return 'signed-out';
  return me.tier === 'max' ? 'max' : 'signed-in';
}

export const WEBHOOK_EVENTS: { key: WebhookEvent; text: string }[] = [
  { key: 'check.completed', text: 'A check you started finished' },
  { key: 'watch.changed', text: 'A project you watch changed' },
];

/** "ak_live_Ab3x…": all the list ever shows of a key */
export const keyShown = (k: Pick<ApiKeyDTO, 'prefix'>) => `${k.prefix}…`;

/** The status pill of a webhook: switched off after failed deliveries, failing lately, or fine. */
export function hookStatus(h: Pick<WebhookDTO, 'disabled' | 'failCount'>): { text: string; cls: 'ok' | 'warn' | 'fail' } {
  if (h.disabled) return { text: 'Disabled', cls: 'fail' };
  if (h.failCount > 0) return { text: 'Failing', cls: 'warn' };
  return { text: 'Active', cls: 'ok' };
}

/** "HTTP 200", "HTTP 500", "No response" (network error, timeout, refused) */
export const responseText = (code: number | null) => (code != null ? `HTTP ${code}` : 'No response');

/** The pill of one delivery: delivered, waiting for its first try or a retry, or given up. */
export function deliveryStatus(d: Pick<WebhookDeliveryDTO, 'status' | 'attempts'>): { text: string; cls: 'ok' | 'warn' | 'fail' } {
  if (d.status === 'ok') return { text: 'Delivered', cls: 'ok' };
  if (d.status === 'failed') return { text: 'Failed', cls: 'fail' };
  return { text: d.attempts > 0 ? 'Retrying' : 'Pending', cls: 'warn' };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The webhook URL as the person typed it, or a plain message when it can't be one. The API checks the rest (https, public). */
export function webhookUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Enter the URL of your endpoint.';
  try {
    const u = new URL(text);
    if (u.protocol === 'https:' || u.protocol === 'http:') return null;
  } catch {
    /* fall through */
  }
  return 'Enter the full URL of your endpoint, starting with https://.';
}

/* ---------------- shared pieces ---------------- */

/**
 * A button that waits for a request: aria-disabled instead of disabled, because a focused button that turns disabled
 * drops keyboard focus to <body>. The handlers ignore clicks while busy.
 */
const waiting = (busy: boolean) => (busy ? ({ 'aria-disabled': true } as const) : {});

/** The API's own words for a failed call (`.message` is ApiErrorBody.error). */
const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Try again in a moment.');

/** Copy to the clipboard; without the async clipboard (permissions, older browsers) select the field and copy that. */
async function copyText(text: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  if (!field) return false;
  field.focus();
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * A secret shown once (a new API key, a webhook signing secret): a read-only mono field with Copy and a plain warning.
 * Focus lands on the field so a screen reader reads it out; Done drops it for good.
 */
export function OnceSecret({ title, value, label, onDone }: { title: ReactNode; value: string; label: string; onDone: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  const toast = useToast();
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className="dev-once" role="group" aria-label={label}>
      <p>
        <b>{title}</b>
      </p>
      <div className="dev-secret">
        <input ref={field} className="mono" readOnly value={value} aria-label={label} spellCheck={false} onFocus={e => e.currentTarget.select()} />
        <button
          className="btn sm"
          type="button"
          onClick={async () => toast((await copyText(value, field.current)) ? 'Copied' : 'Select it and copy it with your keyboard')}
        >
          <CopyIcon />
          Copy
        </button>
      </div>
      <p className="dev-warn">Copy it now and keep it somewhere safe. It won&apos;t be shown again.</p>
      <div>
        <button className="btn sm" type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A list the API serves to the signed-in Max viewer: loads on mount, reloads on demand, cancels on unmount. */
function useDevList<T>(load: (o: { signal: AbortSignal }) => Promise<{ items: T[] }>, onDenied: (e: ApiRequestError) => void) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<AbortController | null>(null);
  const denied = useRef(onDenied);
  denied.current = onDenied;

  const reload = useCallback(async () => {
    live.current?.abort();
    const ctl = new AbortController();
    live.current = ctl;
    try {
      const res = await load({ signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setItems(res.items);
      setError(null);
    } catch (e) {
      if (isAbortError(e) || ctl.signal.aborted) return;
      setError(errText(e));
      if (isApiError(e) && (e.status === 401 || e.status === 403)) denied.current(e);
    }
  }, [load]);

  useEffect(() => {
    void reload();
    return () => live.current?.abort();
  }, [reload]);

  return { items, setItems, error, reload };
}

/** A two-step destructive button: "Revoke" → "Yes, revoke" + "Cancel", focus following along. */
function ConfirmButton({ label, confirm, busy, onConfirm, describedBy }: { label: string; confirm: string; busy: boolean; onConfirm: () => void; describedBy?: string }) {
  const [asking, setAsking] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (asking ? yes : first).current?.focus();
  }, [asking]);
  const set = (v: boolean) => {
    moved.current = true;
    setAsking(v);
  };
  if (!asking) {
    return (
      <button ref={first} className="btn sm" type="button" onClick={() => set(true)} aria-describedby={describedBy}>
        {label}
      </button>
    );
  }
  return (
    <>
      <button ref={yes} className="btn sm danger" type="button" onClick={() => !busy && onConfirm()} {...waiting(busy)} aria-describedby={describedBy}>
        {confirm}
      </button>
      <button className="btn sm" type="button" onClick={() => !busy && set(false)} {...waiting(busy)}>
        Cancel
      </button>
    </>
  );
}

/* ---------------- the line under the code ---------------- */

/** Non-Max viewers: what keys, webhooks and MCP need; signed out also the way in. */
export function DevNote() {
  const { me } = useMe();
  const { openWallets } = useAccount();
  const who = devViewer(me);
  if (who === 'max') return null;
  return (
    <p className="dev-note">
      <span>{MAX_LINE}</span>
      {who === 'signed-out' ? (
        <button className="btn btn-primary sm" type="button" onClick={() => openWallets()}>
          Connect wallet
        </button>
      ) : null}
    </p>
  );
}

/* ---------------- API keys ---------------- */

const loadKeys = (o: { signal: AbortSignal }) => apiKeys(o);
const loadHooks = (o: { signal: AbortSignal }) => webhooks(o);

function KeysPanel({ me, onDenied }: { me: MeDTO; onDenied: (e: ApiRequestError) => void }) {
  const toast = useToast();
  const { items, setItems, error, reload } = useDevList<ApiKeyDTO>(loadKeys, onDenied);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await createApiKey(name.trim() || undefined);
      const { key, ...row } = res;
      setCreated({ id: row.id, key, name: row.name });
      setItems(list => [row, ...(list ?? []).filter(k => k.id !== row.id)]);
      setName('');
    } catch (err) {
      setMsg(errText(err));
      if (isApiError(err) && (err.status === 401 || err.status === 403)) onDenied(err);
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKeyDTO) {
    if (revoking) return;
    setRevoking(k.id);
    try {
      await revokeApiKey(k.id);
      setItems(list => (list ?? []).filter(x => x.id !== k.id));
      // a key revoked while it is still shown is of no use to copy
      setCreated(c => (c?.id === k.id ? null : c));
      toast(`Revoked ${k.name}`);
      input.current?.focus();
    } catch (err) {
      toast(errText(err));
      if (isApiError(err, 'not_found')) {
        setCreated(c => (c?.id === k.id ? null : c));
        void reload();
      }
      // signed out meanwhile: the page follows (DevTools goes, the line under the code comes back)
      if (isApiError(err) && (err.status === 401 || err.status === 403)) onDenied(err);
    } finally {
      setRevoking(null);
    }
  }

  const perDay = me.maxChecksPerDay;
  return (
    <div className="sec2" id="keys">
      <h2>Your API keys</h2>
      <p className="dev-sub">
        Send a key as <code>Authorization: Bearer ak_live_…</code> to the REST API or the MCP server. Checks made with it
        count toward your {perDay ? `${perDay} checks a day` : 'daily checks'}.
      </p>
      <form className="dev-form" onSubmit={create} noValidate>
        <div className="dev-field">
          <input
            ref={input}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={KEY_NAME_MAX}
            placeholder="Key name (optional)"
            aria-label="Key name (optional)"
            readOnly={busy}
          />
          <button className="btn btn-primary sm" type="submit" {...waiting(busy)}>
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
      {msg ? (
        <p className="dev-msg" role="alert">
          {msg}
        </p>
      ) : null}
      {created ? (
        <OnceSecret
          title={`Your new key${created.name ? `: ${created.name}` : ''}`}
          value={created.key}
          label="New API key"
          onDone={() => {
            setCreated(null);
            input.current?.focus();
          }}
        />
      ) : null}
      <div className="tbl dev-tbl ktbl">
        <div className="tr th">
          <span>Key</span>
          <span className="c-col">Created</span>
          <span className="c-col">Last used</span>
          <span />
        </div>
        {items == null ? (
          <p className="tbl-empty">{error ?? 'Loading your keys…'}</p>
        ) : items.length === 0 ? (
          <p className="tbl-empty">{error ?? 'No API keys yet. Create one to call the API or add the MCP server.'}</p>
        ) : (
          items.map(k => (
            <div className="tr" key={k.id} data-key-id={k.id}>
              <span className="td c-nm">
                <span className="nm" id={`${hint}-${k.id}`}>
                  <span className="nm1">
                    <b>{k.name}</b>
                  </span>
                  <span className="nm2 mono">{keyShown(k)}</span>
                </span>
              </span>
              <span className="td c-col dev-t">
                <Age ts={k.createdAt} long />
              </span>
              <span className="td c-col dev-t">{k.lastUsedAt ? <Age ts={k.lastUsedAt} long /> : <span className="muted">Never</span>}</span>
              <span className="td c-mob">
                <span>
                  Created <Age ts={k.createdAt} long />
                </span>
                <span>{k.lastUsedAt ? <>Last used <Age ts={k.lastUsedAt} long /></> : 'Never used'}</span>
              </span>
              <span className="td c-act dev-acts">
                <ConfirmButton label="Revoke" confirm="Yes, revoke" busy={revoking === k.id} onConfirm={() => void revoke(k)} describedBy={`${hint}-${k.id}`} />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- webhooks ---------------- */

function DeliveryList({ items, error }: { items: WebhookDeliveryDTO[] | null; error: string | null }) {
  if (items == null) return <p>{error ?? 'Loading deliveries…'}</p>;
  if (!items.length) return <p>{error ?? 'No deliveries yet. Send a test to see one here.'}</p>;
  return (
    <>
      {error ? <p>{error}</p> : null}
      <ul className="dlv">
        {items.map(d => {
          const st = deliveryStatus(d);
          return (
            <li key={d.id} data-delivery={d.status}>
              <span className={`pill ${st.cls}`}>{st.text}</span>
              <span className="dlv-m">
                <b className="mono">{d.event}</b>
                {d.attempts > 0 ? <span>{responseText(d.responseCode)}</span> : null}
                <span>{plural(d.attempts, 'attempt')}</span>
                {d.checkId ? (
                  <Link href={reportPath(d.checkId)} prefetch={false} className="lnk">
                    Report
                  </Link>
                ) : null}
              </span>
              <Age ts={d.deliveredAt ?? d.createdAt} long className="dlv-t" />
              {d.error && d.status !== 'ok' ? <small>{d.error}</small> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function HookRow({ h, onChange, onRemoved, onDenied }: { h: WebhookDTO; onChange: (h: WebhookDTO | null) => void; onRemoved: () => void; onDenied: (e: ApiRequestError) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDTO[] | null>(null);
  const [dErr, setDErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'test' | 'enable' | 'delete'>(null);
  /** the test ping being waited for, and how many more times to look */
  const [awaiting, setAwaiting] = useState<{ id: string; left: number } | null>(null);
  const moreId = useId();
  const urlId = useId();
  const st = hookStatus(h);
  // the parent passes a new function every render; the poll below must not restart for that
  const changed = useRef(onChange);
  changed.current = onChange;

  /**
   * Only the newest load is shown (a slow older answer must not put a delivery back to pending). Resolves false when
   * looking again is pointless (pollStops).
   */
  const seq = useRef(0);
  const loadDeliveries = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const my = ++seq.current;
      try {
        const res = await webhookDeliveries(h.id, { signal });
        if (my !== seq.current) return true;
        setDeliveries(res.items);
        setDErr(null);
        return true;
      } catch (e) {
        if (isAbortError(e) || my !== seq.current) return true;
        setDErr(errText(e));
        if (isApiError(e) && (e.status === 401 || e.status === 403)) onDenied(e);
        // deleted in another tab: the list is read again, which drops this row
        if (isApiError(e, 'not_found')) changed.current(null);
        return !pollStops(e);
      }
    },
    [h.id, onDenied],
  );

  // the deliveries load when the row opens
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    void loadDeliveries(ctl.signal);
    return () => ctl.abort();
  }, [open, loadDeliveries]);

  // once any load shows the test ping settled (the worker can deliver it before the list first loads), the row's own
  // status (last delivery, HTTP code) is read again
  useEffect(() => {
    if (!awaiting || !deliveries) return;
    const d = deliveries.find(x => x.id === awaiting.id);
    if (d && d.status !== 'pending') {
      setAwaiting(null);
      changed.current(null);
    }
  }, [deliveries, awaiting]);

  // until then, look again after testPollDelay (at most TEST_POLL_MAX times); a 429, 401/403 or 404 ends the wait
  useEffect(() => {
    if (!awaiting || awaiting.left <= 0) return;
    const { id, left } = awaiting;
    const t = window.setTimeout(async () => {
      const goOn = await loadDeliveries();
      setAwaiting(a => (a && a.id === id ? (goOn ? { id, left: a.left - 1 } : null) : a));
    }, testPollDelay(TEST_POLL_MAX - left));
    return () => window.clearTimeout(t);
  }, [awaiting, loadDeliveries]);

  async function sendTest() {
    if (busy) return;
    setBusy('test');
    try {
      const d = await testWebhook(h.id);
      setDeliveries(list => [d, ...(list ?? []).filter(x => x.id !== d.id)]);
      setOpen(true);
      setAwaiting({ id: d.id, left: TEST_POLL_MAX });
      toast('Test ping sent');
    } catch (e) {
      toast(errText(e));
      // 409 webhook_disabled: switched off meanwhile; 404: deleted in another tab
      if (isApiError(e, 'webhook_disabled') || isApiError(e, 'not_found')) onChange(null);
      if (isApiError(e) && (e.status === 401 || e.status === 403)) onDenied(e);
    } finally {
      setBusy(null);
    }
  }

  async function enable() {
    if (busy) return;
    setBusy('enable');
    try {
      onChange(await enableWebhook(h.id));
      toast('Webhook enabled');
    } catch (e) {
      toast(errText(e));
      if (isApiError(e, 'not_found')) onChange(null);
      if (isApiError(e) && (e.status === 401 || e.status === 403)) onDenied(e);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy('delete');
    try {
      await deleteWebhook(h.id);
      toast('Webhook deleted');
      onRemoved();
    } catch (e) {
      // already deleted (in another tab): what was asked for is done, so the row goes (and with it this component)
      if (isApiError(e, 'not_found')) {
        toast('Webhook deleted');
        onRemoved();
        return;
      }
      toast(errText(e));
      if (isApiError(e) && (e.status === 401 || e.status === 403)) onDenied(e);
      setBusy(null);
    }
  }

  const events = h.events.join(' · ');
  return (
    <div className="hook" data-hook-id={h.id}>
      <div className="tr">
        <span className="td c-nm">
          <span className="nm">
            <span className="nm1">
              <b className="mono dev-url" id={urlId} title={h.url}>
                {h.url}
              </b>
            </span>
            <span className="nm2">
              {events}
              {h.disabled ? ` · Turned off after ${plural(h.failCount, 'failed delivery', 'failed deliveries')} in a row` : ''}
            </span>
          </span>
        </span>
        <span className="td c-sc">
          <span className={`pill ${st.cls}`}>{st.text}</span>
        </span>
        <span className="td c-col dev-t">
          {h.lastDeliveryAt ? (
            <>
              {responseText(h.lastStatus)} · <Age ts={h.lastDeliveryAt} long />
            </>
          ) : (
            <span className="muted">No deliveries yet</span>
          )}
        </span>
        <span className="td c-mob">
          {h.lastDeliveryAt ? (
            <span>
              Last delivery: {responseText(h.lastStatus)}, <Age ts={h.lastDeliveryAt} long />
            </span>
          ) : (
            <span>No deliveries yet</span>
          )}
        </span>
        <span className="td c-act dev-acts">
          {h.disabled ? (
            <button className="btn btn-primary sm" type="button" onClick={enable} {...waiting(!!busy)} aria-describedby={urlId}>
              Enable
            </button>
          ) : (
            <button className="btn sm" type="button" onClick={sendTest} {...waiting(!!busy)} aria-describedby={urlId}>
              {busy === 'test' ? 'Sending…' : 'Send test'}
            </button>
          )}
          <button className="btn sm" type="button" aria-expanded={open} aria-controls={moreId} onClick={() => setOpen(o => !o)} aria-describedby={urlId}>
            Deliveries
          </button>
          <ConfirmButton label="Delete" confirm="Yes, delete" busy={busy === 'delete'} onConfirm={() => void remove()} describedBy={urlId} />
        </span>
      </div>
      <div className="dep-more dev-more" id={moreId} hidden={!open}>
        {open ? <DeliveryList items={deliveries} error={dErr} /> : null}
      </div>
    </div>
  );
}

function WebhooksPanel({ onDenied }: { onDenied: (e: ApiRequestError) => void }) {
  const { items, setItems, error, reload } = useDevList<WebhookDTO>(loadHooks, onDenied);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['check.completed']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string; url: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = webhookUrlProblem(url) ?? (events.length ? null : 'Pick at least one event.');
    if (problem) {
      setMsg(problem);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await createWebhook({ url: url.trim(), events });
      const { secret, ...row } = res;
      setCreated({ id: row.id, secret, url: row.url });
      setItems(list => [row, ...(list ?? []).filter(x => x.id !== row.id)]);
      setUrl('');
    } catch (err) {
      setMsg(errText(err));
      if (isApiError(err) && (err.status === 401 || err.status === 403)) onDenied(err);
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const toggle = (ev: WebhookEvent, on: boolean) => setEvents(list => (on ? [...new Set([...list, ev])] : list.filter(x => x !== ev)));
  const replace = useCallback(
    (id: string, h: WebhookDTO | null) => {
      if (h) setItems(list => (list ?? []).map(x => (x.id === id ? h : x)));
      else void reload();
    },
    [reload, setItems],
  );

  return (
    <div className="sec2" id="webhooks">
      <h2>Webhooks</h2>
      <p className="dev-sub">
        We POST the event to your URL as JSON, signed with the webhook&apos;s secret in the <code>ApeCheck-Signature</code> header.
        A webhook that keeps failing is turned off until you enable it again.
      </p>
      <form className="dev-form dev-hook-form" onSubmit={add} noValidate>
        <div className="dev-field">
          <input
            ref={input}
            type="url"
            inputMode="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-server.com/apecheck"
            aria-label="Webhook URL"
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
          />
          <button className="btn btn-primary sm" type="submit" {...waiting(busy)}>
            {busy ? 'Adding…' : 'Add webhook'}
          </button>
        </div>
        <fieldset className="dev-evs">
          <legend className="sr-only">Events to send</legend>
          {WEBHOOK_EVENTS.map(ev => (
            <label key={ev.key} className="dev-ev">
              <input type="checkbox" checked={events.includes(ev.key)} onChange={e => toggle(ev.key, e.target.checked)} disabled={busy} />
              <span className="mono">{ev.key}</span>
              <small>{ev.text}</small>
            </label>
          ))}
        </fieldset>
      </form>
      {msg ? (
        <p className="dev-msg" role="alert">
          {msg}
        </p>
      ) : null}
      {created ? (
        <OnceSecret
          title={
            <>
              Signing secret for <span className="mono">{created.url}</span>
            </>
          }
          value={created.secret}
          label="Webhook signing secret"
          onDone={() => {
            setCreated(null);
            input.current?.focus();
          }}
        />
      ) : null}
      <div className="tbl dev-tbl htbl">
        <div className="tr th">
          <span>Endpoint</span>
          <span>Status</span>
          <span className="c-col">Last delivery</span>
          <span />
        </div>
        {items == null ? (
          <p className="tbl-empty">{error ?? 'Loading your webhooks…'}</p>
        ) : items.length === 0 ? (
          <p className="tbl-empty">{error ?? 'No webhooks yet. Add your endpoint above to get verdicts pushed to it.'}</p>
        ) : (
          items.map(h => (
            <HookRow
              key={h.id}
              h={h}
              onChange={next => replace(h.id, next)}
              onRemoved={() => {
                setItems(list => (list ?? []).filter(x => x.id !== h.id));
                // the secret of a deleted webhook signs nothing any more
                setCreated(c => (c?.id === h.id ? null : c));
                input.current?.focus();
              }}
              onDenied={onDenied}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- the Max viewer's tools ---------------- */

/** "Your API keys" and "Webhooks" for a signed-in Max viewer; nothing for anyone else. */
export function DevTools() {
  const { me, refresh } = useMe();
  // a 401/403 from these routes means the session or the tier changed: re-read /v1/me so the page follows
  const onDenied = useCallback(() => void refresh(), [refresh]);
  if (!me || devViewer(me) !== 'max') return null;
  return (
    <div key={me.user!.id}>
      <KeysPanel me={me} onDenied={onDenied} />
      <WebhooksPanel onDenied={onDenied} />
    </div>
  );
}
