/**
 * zod schemas for everything a model returns (HANDOFF §4 Stage B/C/E, §7 follow-ups, §11).
 * Model output is never trusted: it is parsed as JSON, validated here, then clamped by
 * the normalise* helpers before anything is stored.
 *
 * The *Out schemas are what the model is asked to produce (kept simple so they map onto
 * structured-output JSON schema). The normalise* helpers enforce lengths and counts.
 */
import { z } from 'zod';
import { CLAIM_KINDS, CLAIM_SOURCES, type ClaimKind, type ClaimSource } from './labels';
import { TUNING } from './config';

export const SignalZ = z.enum(['ok', 'warn', 'fail']);
export const ClaimStatusZ = z.enum(['seen_working', 'not_seen', 'contradicted', 'checks_out']);
export const ClaimSourceZ = z.enum(CLAIM_SOURCES as [ClaimSource, ...ClaimSource[]]);
export const ClaimKindZ = z.enum(CLAIM_KINDS as [ClaimKind, ...ClaimKind[]]);

/* ---------- Stage C: claim extraction (AI_MODEL_FAST) ---------- */
export const ExtractedClaimZ = z.object({
  text: z.string(),
  source: ClaimSourceZ,
  kind: ClaimKindZ,
});
export const ClaimsOutZ = z.object({ claims: z.array(ExtractedClaimZ) });
export type ExtractedClaim = z.infer<typeof ExtractedClaimZ>;
export type ClaimsOut = z.infer<typeof ClaimsOutZ>;

export function normaliseClaims(out: ClaimsOut): ExtractedClaim[] {
  const seen = new Set<string>();
  const res: ExtractedClaim[] = [];
  for (const c of out.claims) {
    const text = clip(c.text.replace(/\s+/g, ' ').trim().replace(/^["“”']+|["“”']+$/g, ''), 140);
    const k = text.toLowerCase();
    if (text.length < 4 || seen.has(k)) continue;
    seen.add(k);
    res.push({ text, source: c.source, kind: c.kind });
    if (res.length >= TUNING.maxClaims) break;
  }
  return res;
}

/* ---------- Stage E: judge (AI_MODEL_JUDGE) ---------- */
export const JudgedClaimZ = z.object({
  /** index into the claims list given to the model */
  index: z.number().int(),
  status: ClaimStatusZ,
  /** one sentence that cites the step it relies on */
  evidence: z.string(),
  /** idx of the CheckStep the evidence relies on, or -1 */
  stepIdx: z.number().int(),
});
export const JudgeOutZ = z.object({
  claims: z.array(JudgedClaimZ),
  acct: SignalZ,
  git: SignalZ,
  /** one or two plain sentences, ≤180 chars */
  summary: z.string(),
  /** coins only; empty string when there is no coin */
  coinSummary: z.string(),
});
export type JudgeOut = z.infer<typeof JudgeOutZ>;

export interface JudgedClaim { index: number; status: z.infer<typeof ClaimStatusZ>; evidence: string; stepIdx: number | null }
export interface Judged {
  claims: JudgedClaim[];
  acct: z.infer<typeof SignalZ>;
  git: z.infer<typeof SignalZ>;
  summary: string;
  coinSummary: string | null;
}

export function normaliseJudge(out: JudgeOut, claimCount: number, stepCount: number): Judged {
  const byIndex = new Map<number, JudgedClaim>();
  for (const c of out.claims) {
    if (c.index < 0 || c.index >= claimCount || byIndex.has(c.index)) continue;
    byIndex.set(c.index, {
      index: c.index,
      status: c.status,
      evidence: clip(c.evidence.replace(/\s+/g, ' ').trim(), 220),
      stepIdx: c.stepIdx >= 0 && c.stepIdx < stepCount ? c.stepIdx : null,
    });
  }
  return {
    claims: [...byIndex.values()].sort((a, b) => a.index - b.index),
    acct: out.acct,
    git: out.git,
    summary: clipSentence(out.summary, 180),
    coinSummary: out.coinSummary.trim() ? clipSentence(out.coinSummary, 180) : null,
  };
}

/* ---------- Stage B: browser tools (AI_MODEL_JUDGE) ---------- */
export const ClickInputZ = z.object({ text: z.string().min(1).max(120) });
export const ScrollInputZ = z.object({ direction: z.enum(['down', 'up']).optional() });
export const OpenLinkInputZ = z.object({ url: z.string().min(1).max(2048) });
export const DoneInputZ = z.object({ reason: z.string().max(300) });
export const BROWSER_TOOL_NAMES = ['click', 'scroll', 'open_link', 'done'] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/* ---------- follow-up answers (site asks + bot) ---------- */
export const AnswerOutZ = z.object({ answer: z.string() });
export const normaliseAnswer = (a: z.infer<typeof AnswerOutZ>, max = 600) => clipSentence(a.answer, max);

/* ---------- helpers ---------- */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
/** Clip to max chars, preferring to cut at a sentence end. */
export function clipSentence(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : clip(t, max);
}
