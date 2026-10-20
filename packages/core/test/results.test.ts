import { describe, expect, it } from 'vitest';
import { checkResultOf, checkVerdictEnum, type CheckResultRow } from '../src/results';

const ROW: CheckResultRow = {
  shortId: '8f2a91x',
  targetRaw: 'orbitswap.xyz',
  narScore: 48,
  narBand: 'partly',
  coinScore: 44,
  coinBand: 'sketchy',
  totalScore: 46,
  summary: "The app loads but the main flow stops at 'Coming soon'.",
  status: 'DONE',
  error: null,
};

describe('checkResultOf (webhook check.completed = MCP run_check)', () => {
  it('is the flat shape of the /api page', () => {
    expect(checkResultOf(ROW, 'https://apecheck.io/')).toEqual({
      id: '8f2a91x',
      target: 'orbitswap.xyz',
      narrative: 48,
      coin: 44,
      total: 46,
      verdict: 'PARTLY_REAL',
      summary: "The app loads but the main flow stops at 'Coming soon'.",
      report_url: 'https://apecheck.io/c/8f2a91x',
    });
  });

  it('a failed check: no scores or verdict, the reason as summary', () => {
    const r = checkResultOf({ ...ROW, status: 'FAILED', error: 'The site did not load' }, 'https://apecheck.io');
    expect(r).toMatchObject({ narrative: null, coin: null, total: null, verdict: null, summary: 'The site did not load' });
    expect(checkResultOf({ ...ROW, status: 'FAILED', error: null }, 'https://apecheck.io').summary).toBe('The check could not finish');
  });
});

describe('checkVerdictEnum', () => {
  it('the narrative verdict from the stored band, else from the score', () => {
    expect(checkVerdictEnum(ROW)).toBe('PARTLY_REAL');
    expect(checkVerdictEnum({ ...ROW, narBand: null, narScore: 85 })).toBe('REAL');
    expect(checkVerdictEnum({ ...ROW, narBand: 'bogus', narScore: 10 })).toBe('LARP');
  });
  it('the coin verdict when only the coin was scored; null without scores', () => {
    expect(checkVerdictEnum({ ...ROW, narScore: null, narBand: null })).toBe('SKETCHY');
    expect(checkVerdictEnum({ narScore: null, narBand: null, coinScore: 90, coinBand: null })).toBe('CLEAN');
    expect(checkVerdictEnum({ narScore: null, narBand: null, coinScore: null, coinBand: 'ok' })).toBeNull();
  });
});
