import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOLERANCE_S, signWebhook, verifyWebhook, webhookSignature } from '../src/node';

const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuv';
const BODY = JSON.stringify({ id: 'd1', event: 'ping', created: '2026-10-19T00:00:00.000Z' });
const T = 1_729_325_580;

describe('signWebhook / verifyWebhook', () => {
  it('signs `${t}.${body}` with HMAC-SHA256 in the t=,v1= header', () => {
    const header = signWebhook(SECRET, BODY, T);
    const hex = createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex');
    expect(header).toBe(`t=${T},v1=${hex}`);
    expect(webhookSignature(SECRET, Buffer.from(BODY), T)).toBe(hex);
  });

  it('accepts the exact body within the tolerance, string or bytes', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(verifyWebhook(SECRET, BODY, header, { now: T })).toBe(true);
    expect(verifyWebhook(SECRET, Buffer.from(BODY), header, { now: T + WEBHOOK_TOLERANCE_S })).toBe(true);
    expect(verifyWebhook(SECRET, BODY, header, { now: T - 299 })).toBe(true);
    // spaces around entries, an unknown scheme and a second (rotated) v1 entry are fine
    const other = webhookSignature('whsec_other', BODY, T);
    expect(verifyWebhook(SECRET, BODY, ` t=${T}, v0=abc, v1=${other}, v1=${webhookSignature(SECRET, BODY, T)}`, { now: T })).toBe(true);
  });

  it('refuses a changed body, another secret, an old or future timestamp and malformed headers', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(verifyWebhook(SECRET, BODY + ' ', header, { now: T })).toBe(false);
    expect(verifyWebhook('whsec_other', BODY, header, { now: T })).toBe(false);
    expect(verifyWebhook(SECRET, BODY, header, { now: T + WEBHOOK_TOLERANCE_S + 1 })).toBe(false);
    expect(verifyWebhook(SECRET, BODY, header, { now: T - WEBHOOK_TOLERANCE_S - 1 })).toBe(false);
    // a replayed signature under a new timestamp
    expect(verifyWebhook(SECRET, BODY, header.replace(`t=${T}`, `t=${T + 10}`), { now: T })).toBe(false);
    for (const bad of [undefined, null, '', 'garbage', `t=${T}`, `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, `t=${T},v1=zz`]) {
      expect(verifyWebhook(SECRET, BODY, bad, { now: T })).toBe(false);
    }
    expect(verifyWebhook('', BODY, header, { now: T })).toBe(false);
    // a custom tolerance
    expect(verifyWebhook(SECRET, BODY, header, { now: T + 60, toleranceS: 30 })).toBe(false);
  });

  it('defaults t to now', () => {
    const header = signWebhook(SECRET, BODY);
    expect(verifyWebhook(SECRET, BODY, header)).toBe(true);
  });
});
