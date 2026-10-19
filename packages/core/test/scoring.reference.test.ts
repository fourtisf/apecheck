/**
 * The ported scoring must behave exactly like reference/scoring.ts (copied verbatim into
 * test/reference-scoring.ts). Exhaustive over every signal combination.
 */
import { describe, expect, it } from 'vitest';
import * as port from '../src/scoring';
import * as ref from './reference-scoring';

const SIG = ['ok', 'warn', 'fail'] as const;
const CLAIM = ['seen_working', 'not_seen', 'contradicted', 'checks_out'] as const;
const REC = ['builder', 'mixed', 'serial'] as const;

function claimLists(): (typeof CLAIM[number])[][] {
  const out: (typeof CLAIM[number])[][] = [[]];
  for (const a of CLAIM) { out.push([a]); for (const b of CLAIM) { out.push([a, b]); for (const c of CLAIM) out.push([a, b, c]); } }
  out.push(['seen_working', 'seen_working', 'not_seen', 'contradicted', 'checks_out', 'not_seen', 'seen_working', 'contradicted']);
  return out;
}

describe('scoring port matches reference', () => {
  it('config and bands are identical', () => {
    expect(port.CONFIG).toEqual(ref.CONFIG);
    expect(port.NAR_BANDS).toEqual(ref.NAR_BANDS);
    expect(port.COIN_BANDS).toEqual(ref.COIN_BANDS);
    expect(port.SIGNAL_VALUE).toEqual(ref.SIGNAL_VALUE);
    expect(port.CLAIM_VALUE).toEqual(ref.CLAIM_VALUE);
  });

  it('scoreNarrative: every signal combination × claim lists', () => {
    let n = 0;
    for (const launch of SIG) for (const flow of SIG) for (const docs of SIG) for (const acct of SIG) for (const git of SIG)
      for (const claims of claimLists()) {
        const i = { launch, flow, docs, acct, git, claims };
        expect(port.scoreNarrative(i)).toEqual(ref.scoreNarrative(i));
        n++;
      }
    expect(n).toBeGreaterThan(20000);
  });

  it('scoreCoin and scoreCheck: every combination', () => {
    for (const deployer of REC) for (const bundle of SIG) for (const holders of SIG) for (const lp of SIG) for (const authorities of SIG) {
      const c = { deployer, bundle, holders, lp, authorities };
      expect(port.scoreCoin(c)).toEqual(ref.scoreCoin(c));
      const n = { launch: 'ok', flow: 'warn', docs: 'ok', acct: 'warn', git: 'fail', claims: ['seen_working', 'not_seen'] } as const;
      expect(port.scoreCheck({ ...n, claims: [...n.claims] }, c)).toEqual(ref.scoreCheck({ ...n, claims: [...n.claims] }, c));
    }
  });

  it('signal helpers', () => {
    for (let v = -1; v <= 101; v += 0.5) {
      expect(port.bandSignal(v, port.CONFIG.bundlePct)).toBe(ref.bandSignal(v, ref.CONFIG.bundlePct));
      for (let d = 0; d <= 30; d += 1.5) expect(port.holdersSignal(v, d)).toBe(ref.holdersSignal(v, d));
    }
    for (let l = 0; l <= 40; l++) for (let d = 0; d <= l; d++) expect(port.deployerRecord(l, d)).toBe(ref.deployerRecord(l, d));
    for (const lp of ['burned', 'locked', 'unlocked'] as const) for (const days of [0, 30, 179, 180, 365]) expect(port.lpSignal(lp, days)).toBe(ref.lpSignal(lp, days));
    for (const a of [true, false]) for (const b of [true, false]) expect(port.authoritiesSignal(a, b)).toBe(ref.authoritiesSignal(a, b));
    for (const t of [0, 59, 60, 61, 100]) for (const c of [null, 0, 59, 60, 100]) expect(port.checkedOut(t, c)).toBe(ref.checkedOut(t, c));
    for (let s = 0; s <= 100; s++) { expect(port.narBand(s)).toEqual(ref.narBand(s)); expect(port.coinBand(s)).toEqual(ref.coinBand(s)); }
  });
});
