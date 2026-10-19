import { describe, expect, it } from 'vitest';
import { scoreNarrative, scoreCoin, scoreCheck, narBand, coinBand, deployerRecord, lpSignal, holdersSignal, CONFIG } from '../src/scoring';

const all = (s: 'ok' | 'warn' | 'fail') => ({ launch: s, flow: s, docs: s, acct: s, git: s });

describe('scoreNarrative', () => {
  it('perfect project scores 100 and is Real', () => {
    const r = scoreNarrative({ ...all('ok'), claims: ['seen_working', 'checks_out'] });
    expect(r.score).toBe(100);
    expect(r.band.key).toBe('real');
    expect(r.areas).toEqual({ Product: 100, Claims: 100, People: 100 });
  });
  it('everything failing scores 0 and is LARP', () => {
    const r = scoreNarrative({ ...all('fail'), claims: ['contradicted'] });
    expect(r.score).toBe(0);
    expect(r.band.key).toBe('larp');
  });
  it('no claims count as 0.5 (neutral)', () => {
    expect(scoreNarrative({ ...all('ok'), claims: [] }).areas.Claims).toBe(50);
  });
  it('a dead or waitlist-only site can never score above Partly real (M1 acceptance)', () => {
    for (const launch of ['warn', 'fail'] as const) {
      const r = scoreNarrative({ launch, flow: 'ok', docs: 'ok', acct: 'ok', git: 'ok', claims: ['seen_working', 'seen_working', 'checks_out'] });
      expect(r.score).toBeLessThanOrEqual(CONFIG.caps.launchNotOk);
      expect(['partly', 'llarp', 'larp']).toContain(r.band.key);
    }
  });
  it('flow can only be tested when launch is ok', () => {
    const a = scoreNarrative({ launch: 'warn', flow: 'ok', docs: 'ok', acct: 'ok', git: 'ok', claims: [] });
    const b = scoreNarrative({ launch: 'warn', flow: 'warn', docs: 'ok', acct: 'ok', git: 'ok', claims: [] });
    expect(a).toEqual(b);
  });
  it('a broken main flow caps the score below Real', () => {
    const r = scoreNarrative({ launch: 'ok', flow: 'warn', docs: 'ok', acct: 'ok', git: 'ok', claims: ['seen_working'] });
    expect(r.score).toBe(CONFIG.caps.flowNotOk);
    expect(r.band.key).toBe('likely');
  });
});

describe('scoreCoin', () => {
  const clean = { bundle: 'ok', holders: 'ok', lp: 'ok', authorities: 'ok' } as const;
  it('clean builder coin scores 100', () => expect(scoreCoin({ deployer: 'builder', ...clean }).score).toBe(100));
  it('serial launcher caps at 42 (Sketchy at best)', () => {
    const r = scoreCoin({ deployer: 'serial', ...clean });
    expect(r.score).toBe(42);
    expect(r.band.key).toBe('sketchy');
  });
  it('mixed record caps at 72', () => expect(scoreCoin({ deployer: 'mixed', ...clean }).score).toBe(72));
});

describe('scoreCheck', () => {
  it('total averages narrative and coin when a coin is linked', () => {
    const r = scoreCheck({ ...all('ok'), claims: ['seen_working'] }, { deployer: 'serial', bundle: 'fail', holders: 'fail', lp: 'fail', authorities: 'fail' });
    expect(r.coin!.score).toBe(0);
    expect(r.total).toBe(50);
    expect(r.totalBand.key).toBe('partly');
  });
  it('total is the narrative score without a coin', () => {
    const r = scoreCheck({ ...all('warn'), claims: ['not_seen'] });
    expect(r.coin).toBeNull();
    expect(r.total).toBe(r.narrative.score);
  });
});

describe('bands and helpers', () => {
  it('narrative band edges', () => {
    expect([80, 79, 60, 59, 40, 39, 20, 19, 0].map(s => narBand(s).key)).toEqual(['real', 'likely', 'likely', 'partly', 'partly', 'llarp', 'llarp', 'larp', 'larp']);
  });
  it('coin band edges', () => {
    expect([80, 79, 60, 59, 35, 34, 0].map(s => coinBand(s).key)).toEqual(['clean', 'ok', 'ok', 'sketchy', 'sketchy', 'rigged', 'rigged']);
  });
  it('deployer records', () => {
    expect(deployerRecord(1, 0)).toBe('builder');
    expect(deployerRecord(0, 0)).toBe('builder');
    expect(deployerRecord(5, 1)).toBe('builder');
    expect(deployerRecord(6, 1)).toBe('mixed');
    expect(deployerRecord(8, 6)).toBe('serial');
    expect(deployerRecord(8, 5)).toBe('mixed');
  });
  it('lp and holders signals', () => {
    expect(lpSignal('burned')).toBe('ok');
    expect(lpSignal('locked', 30)).toBe('warn');
    expect(lpSignal('locked', 365)).toBe('ok');
    expect(lpSignal('unlocked')).toBe('fail');
    expect(holdersSignal(20, 2)).toBe('ok');
    expect(holdersSignal(20, 9)).toBe('fail');
    expect(holdersSignal(30, 1)).toBe('warn');
  });
});
