/**
 * The share card (.vcard) as a 1200x675 image tree for next/og (satori), in the light theme.
 * Satori only understands inline styles and flexbox, so the prototype's CSS is restated here with
 * the light tokens from globals.css (:root) and every size scaled from the 92 px ring card (S = 2.1).
 * Used by app/card/[id]/route.tsx; server only.
 */
import { CHAINS, KIND_LABEL, coinBand, narBand, type CheckReportDTO } from '@apecheck/core';
import { APP_HOST } from '@/lib/env';
import { cardSource } from '../VCard';

export const CARD_W = 1200;
export const CARD_H = 675;

/** globals.css :root (light) */
const T = {
  panel: '#FFFFFF',
  panel2: '#EEF0F3',
  line: '#E7E9ED',
  bg: '#F3F4F6',
  ink: '#0E0F12',
  mute: '#565C6B',
  dim: '#878D9C',
  acc: '#6A3DF5',
  real: '#0B7F57',
  likely: '#3F7F0F',
  partly: '#A25F00',
  llarp: '#C2410C',
  larp: '#C8203A',
};
/** .n-* / .k-* → --vc */
const NAR_COLOR = { real: T.real, likely: T.likely, partly: T.partly, llarp: T.llarp, larp: T.larp } as const;
const COIN_COLOR = { clean: T.real, ok: T.likely, sketchy: T.partly, rigged: T.larp } as const;

/** color-mix(in srgb, <hex> 11%, transparent) */
function tint(hex: string, a = 0.11): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const S = 2.1;
const px = (n: number) => Math.round(n * S);
const RING = px(92);
const STROKE = px(9);
const PAD_X = px(30);
const GAP = px(18);
/** satori can't resolve percentage widths inside a growing flex item, so the meter column gets a fixed width */
const RIGHT_W = CARD_W - 2 * PAD_X - RING - GAP;

export const CARD_FONT = 'Plus Jakarta Sans';

function Logo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28">
      <rect x="3.5" y="3.5" width="21" height="21" rx="6" transform="rotate(-8 14 14)" fill={T.ink} />
      <path d="M8.6 13.8l3.9 4.3 7-8.8" fill="none" stroke={T.bg} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** ringSVG(n, size, col): track + arc from 12 o'clock */
function Ring({ value, color }: { value: number; color: string }) {
  const c = RING / 2;
  const r = c - px(7);
  const C = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={T.panel2} strokeWidth={STROKE} />
      {v > 0 ? (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${((C * v) / 100).toFixed(1)} ${C.toFixed(1)}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
      ) : null}
    </svg>
  );
}

/** mm(n, band, p, 'Narrative'): "Narrative · Partly real" + score + bar */
function Meter({ label, name, score, color }: { label: string; name: string; score: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: RIGHT_W }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: RIGHT_W, fontSize: px(13), lineHeight: 1.5 }}>
        <span style={{ color, fontWeight: 700 }}>
          {label} · {name}
        </span>
        <span style={{ color: T.ink, fontWeight: 700 }}>{score}</span>
      </div>
      <div style={{ display: 'flex', marginTop: px(5), height: px(5), borderRadius: px(3), background: T.panel2, width: RIGHT_W }}>
        <div style={{ height: px(5), width: Math.round((RIGHT_W * Math.max(0, Math.min(100, score))) / 100), borderRadius: px(3), background: color }} />
      </div>
    </div>
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        padding: `${px(6)}px ${px(14)}px ${px(6)}px ${px(12)}px`,
        borderRadius: 999,
        fontSize: px(16),
        fontWeight: 800,
        lineHeight: 1.5,
        color,
        background: tint(color),
      }}
    >
      <div style={{ width: px(8), height: px(8), borderRadius: 999, background: color, marginRight: px(8) }} />
      {text}
    </div>
  );
}

/** Long model sentences stay on the card: satori clamps to three lines, this keeps the work bounded. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Characters outside what the bundled fonts draw (Plus Jakarta Sans latin + latin-ext, arrows from Geist Mono). */
const NOT_BUNDLED = /[^\u0020-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20C0\u2122\u2190-\u2193\u2212\u2215]/gu;
/**
 * Text going onto the card. Control characters never belong there. In `strict` mode everything the bundled
 * fonts can't draw is dropped too, so the render needs no font or emoji download (satori fetches those otherwise).
 */
function cardText(s: string, strict: boolean): string {
  let t = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (strict) t = t.replace(NOT_BUNDLED, '');
  return t.replace(/\s+/g, ' ').trim();
}

export type CardItem = Pick<
  CheckReportDTO,
  'id' | 'kind' | 'name' | 'handle' | 'domain' | 'chain' | 'total' | 'narScore' | 'coinScore' | 'hasCoin' | 'summary' | 'status' | 'progress'
>;

/**
 * cardHTML(it) at 1200x675. A queued/running check gets the "Testing now" state of the report header.
 * `strict` keeps only text the bundled fonts cover (the fallback when downloading extra glyphs fails).
 */
export function ShareCardImage({ item: it, strict = false }: { item: CardItem; strict?: boolean }) {
  const testing = it.status === 'queued' || it.status === 'running';
  const total = it.total ?? it.narScore ?? 0;
  const ringColor = testing ? T.acc : NAR_COLOR[narBand(total).key];
  const nar = it.narScore != null ? narBand(it.narScore) : null;
  const coin = it.hasCoin && it.coinScore != null ? coinBand(it.coinScore) : null;
  const pct = Math.round(Math.max(0, Math.min(1, it.progress || 0)) * 100);
  const summary = testing
    ? `The agent is working through this check. The verdict lands on ${APP_HOST} when it's done.`
    : clip(cardText(it.summary ?? '', strict), 240);
  const source = cardText(cardSource(it), strict) || KIND_LABEL[it.kind];
  const foot = it.chain && CHAINS[it.chain] ? CHAINS[it.chain].name : KIND_LABEL[it.kind];

  return (
    <div
      style={{
        width: CARD_W,
        height: CARD_H,
        display: 'flex',
        flexDirection: 'column',
        background: T.panel,
        padding: `${px(24)}px ${PAD_X}px`,
        fontFamily: CARD_FONT,
        color: T.ink,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: px(13), color: T.dim, fontWeight: 700 }}>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: px(15), fontWeight: 800, color: T.ink, letterSpacing: '-0.03em' }}>
          <Logo size={px(18)} />
          <span style={{ marginLeft: px(7) }}>apecheck</span>
        </div>
        <span style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: px(18) }}>
        <div style={{ display: 'flex', position: 'relative', width: RING, height: RING, flexShrink: 0 }}>
          <Ring value={testing ? pct : total} color={ringColor} />
          <div style={{ position: 'absolute', top: 0, left: 0, width: RING, height: RING, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: testing ? px(22) : px(26), fontWeight: 800, letterSpacing: '-0.05em', color: T.ink }}>{testing ? `${pct}%` : total}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', width: RIGHT_W, marginLeft: GAP }}>
          {testing ? <Pill text="Testing now" color={T.acc} /> : nar ? <Pill text={nar.name} color={NAR_COLOR[nar.key]} /> : null}
          {!testing ? (
            <div style={{ display: 'flex', flexDirection: 'column', width: RIGHT_W, marginTop: px(12) }}>
              {nar && it.narScore != null ? <Meter label="Narrative" name={nar.name} score={it.narScore} color={NAR_COLOR[nar.key]} /> : null}
              {coin && it.coinScore != null ? (
                <div style={{ display: 'flex', marginTop: px(10) }}>
                  <Meter label="Coin" name={coin.name} score={it.coinScore} color={COIN_COLOR[coin.key]} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {summary ? (
        <div style={{ display: 'block', marginTop: px(18), fontSize: px(14), lineHeight: 1.45, color: T.mute, lineClamp: 3 }}>{summary}</div>
      ) : null}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 'auto',
          paddingTop: px(12),
          borderTop: `${px(1)}px solid ${T.line}`,
          fontSize: px(12),
          color: T.dim,
          fontWeight: 700,
        }}
      >
        <span>{foot}</span>
        <span>
          {APP_HOST}/c/{it.id}
        </span>
      </div>
    </div>
  );
}
