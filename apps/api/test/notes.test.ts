/** M3 community notes and "helpful" votes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckReportDTO, HelpfulResponse, MeDTO, NoteDTO } from '@apecheck/core';
import { dailyKey } from '../src/limits';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

const holderA = new EvmWallet();
const holderB = new SolWallet();
const shortOf = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ TIER_OVERRIDES: `${holderA.address}:pro,${holderB.address}:pro`, NOTES_PER_DAY: '2' });
});
afterAll(async () => h.close());
beforeEach(async () => resetState(h));

async function doneCheck(over: Record<string, unknown> = {}) {
  const t = await seedTarget(h.prisma);
  return seedCheck(h.prisma, { targetId: t.id, ...over });
}

describe('POST /v1/checks/:id/notes', () => {
  it('anonymous: 403 holders_only with the prototype copy; a signed-in wallet without $APECHECK: 403 too', async () => {
    const c = await doneCheck();
    const anon = await new Client(h.app).post(`/v1/checks/${c.shortId}/notes`, { text: 'A Space recording shows the team.' });
    expect(anon.statusCode).toBe(403);
    expect(anon.json()).toEqual({ code: 'holders_only', error: 'Notes are open to $APECHECK holders. Connect a wallet to add one.' });
    const free = new Client(h.app);
    const me = await signedIn(free, new EvmWallet());
    expect(me.user?.holder).toBe(false);
    const res = await free.post(`/v1/checks/${c.shortId}/notes`, { text: 'A Space recording shows the team.' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'holders_only', error: 'Notes are open to $APECHECK holders once the token launches.' });
  });

  it('a holder adds a note (10–500 characters, cleaned) and it shows on the report', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, holderA);
    expect(me.user?.holder).toBe(true);
    const check = await doneCheck();
    for (const text of ['too short', 'x'.repeat(501), '   \n  ', 7]) {
      const res = await c.post(`/v1/checks/${check.shortId}/notes`, { text });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_request', error: 'Notes are 10 to 500 characters.' });
    }
    const res = await c.post(`/v1/checks/${check.shortId}/notes`, { text: '  The dev shipped two tools before.\r\n\n\n\nBoth still live.\u0007 ' });
    expect(res.statusCode).toBe(201);
    const note = res.json<NoteDTO>();
    expect(note).toEqual({
      id: expect.any(String),
      by: shortOf(holderA.address),
      hold: null,
      text: 'The dev shipped two tools before.\n\nBoth still live.',
      helpful: 0,
      mine: false,
      createdAt: expect.any(String),
    });
    const report = (await new Client(h.app).get(`/v1/checks/${check.shortId}`)).json<CheckReportDTO>();
    expect(report.notes).toEqual([note]);
  });

  it('shows "@handle" for authors who linked X', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, holderB);
    await h.prisma.user.update({ where: { id: me.user!.id }, data: { xHandle: 'degen_rina', xUserId: '77' } });
    const check = await doneCheck();
    expect((await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'Ran a Space with the founders.' })).json<NoteDTO>().by).toBe('@degen_rina');
  });

  it('a double submit returns the first note; NOTES_PER_DAY is per user', async () => {
    const c = new Client(h.app);
    await signedIn(c, holderA);
    const check = await doneCheck();
    const a = await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'First note about this project.' });
    const b = await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'First note about this project.' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json<NoteDTO>().id).toBe(a.json<NoteDTO>().id);
    expect((await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'Second note about this project.' })).statusCode).toBe(201);
    const third = await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'Third note about this project.' });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ code: 'rate_limited', error: "You've added 2 notes today. Try again after 00:00 UTC." });
    expect(await h.prisma.note.count()).toBe(2);
  });

  it('the same note sent several times at the same moment makes one note and spends one of the day’s notes', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, holderA);
    const check = await doneCheck();
    const text = 'Posted three times at once by a double tap.';
    const res = await Promise.all([0, 1, 2].map(() => c.post(`/v1/checks/${check.shortId}/notes`, { text })));
    expect(res.map(r => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(res.map(r => r.json<NoteDTO>().id)).size).toBe(1);
    expect(await h.prisma.note.count({ where: { checkId: check.id } })).toBe(1);
    expect(await h.redis.get(dailyKey('notes', me.user!.id))).toBe('1');
    // a different note at the same moment is its own note
    const two = await Promise.all(['Another view on the same project.', 'A third, different view on it.'].map(t => c.post(`/v1/checks/${check.shortId}/notes`, { text: t })));
    expect(two.map(r => r.statusCode).sort()).toEqual([201, 429]);
    expect(await h.prisma.note.count({ where: { checkId: check.id } })).toBe(2);
    expect(await h.redis.get(dailyKey('notes', me.user!.id))).toBe('2');
  });

  it('404 for a missing check or someone else’s private one, 409 while it runs', async () => {
    const c = new Client(h.app);
    await signedIn(c, holderA);
    expect((await c.post('/v1/checks/zzzz999/notes', { text: 'A note for nothing here.' })).statusCode).toBe(404);
    const priv = await doneCheck({ isPrivate: true, requesterSid: 'other' });
    expect((await c.post(`/v1/checks/${priv.shortId}/notes`, { text: 'A note on a private check.' })).statusCode).toBe(404);
    const running = await doneCheck({ status: 'RUNNING' });
    const res = await c.post(`/v1/checks/${running.shortId}/notes`, { text: 'A note while it is running.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_ready');
  });
});

describe('POST /v1/notes/:id/helpful', () => {
  async function noteBy(w: EvmWallet | SolWallet) {
    const c = new Client(h.app, '192.0.2.31');
    await signedIn(c, w);
    const check = await doneCheck();
    return { check, note: (await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'Context the agent could not see.' })).json<NoteDTO>() };
  }

  it('toggles the viewer’s vote and the report says which ones are theirs', async () => {
    const { check, note } = await noteBy(holderA);
    const c = new Client(h.app);
    await signedIn(c, holderB);
    const on = await c.post(`/v1/notes/${note.id}/helpful`);
    expect(on.json<HelpfulResponse>()).toEqual({ helpful: 1, mine: true });
    let report = (await c.get(`/v1/checks/${check.shortId}`)).json<CheckReportDTO>();
    expect(report.notes[0]).toMatchObject({ id: note.id, helpful: 1, mine: true });
    // someone else sees the count but not "mine"
    expect((await new Client(h.app).get(`/v1/checks/${check.shortId}`)).json<CheckReportDTO>().notes[0]).toMatchObject({ helpful: 1, mine: false });
    const off = await c.post(`/v1/notes/${note.id}/helpful`);
    expect(off.json<HelpfulResponse>()).toEqual({ helpful: 0, mine: false });
    report = (await c.get(`/v1/checks/${check.shortId}`)).json<CheckReportDTO>();
    expect(report.notes[0]).toMatchObject({ helpful: 0, mine: false });
  });

  it('two clicks at once count once', async () => {
    const { note } = await noteBy(holderA);
    const c = new Client(h.app);
    await signedIn(c, holderB);
    const res = await Promise.all([c.post(`/v1/notes/${note.id}/helpful`), c.post(`/v1/notes/${note.id}/helpful`)]);
    const final = await h.prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    const votes = await h.prisma.noteVote.count({ where: { noteId: note.id } });
    expect(final.helpful).toBe(votes);
    expect(res.every(r => r.statusCode === 200)).toBe(true);
  });

  it('not on your own note; holders only; 404 for unknown or hidden notes', async () => {
    const { note } = await noteBy(holderA);
    const own = new Client(h.app);
    await signedIn(own, holderA);
    const res = await own.post(`/v1/notes/${note.id}/helpful`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'own_note', error: "You can't mark your own note helpful." });

    expect((await new Client(h.app).post(`/v1/notes/${note.id}/helpful`)).json().code).toBe('holders_only');
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    expect((await free.post(`/v1/notes/${note.id}/helpful`)).json().code).toBe('holders_only');

    const b = new Client(h.app);
    await signedIn(b, holderB);
    expect((await b.post('/v1/notes/cmnotarealnoteid0000000000/helpful')).statusCode).toBe(404);
    expect((await b.post('/v1/notes/bad!/helpful')).statusCode).toBe(404);
    await h.prisma.note.update({ where: { id: note.id }, data: { hidden: true } });
    expect((await b.post(`/v1/notes/${note.id}/helpful`)).statusCode).toBe(404);
  });
});

describe('holdings next to note authors once the token is live', () => {
  it('hold = fmtAmount(holding)', async () => {
    const live = await makeHarness({ TOKEN_ADDRESS: 'APEcheckMint1111111111111111111111111111111', TOKEN_CHAIN: 'sol', PRO_MIN_HOLD: '250000' });
    try {
      await resetState(live);
      const w = new SolWallet();
      live.sources.balances.set(w.address, 3_100_000);
      const c = new Client(live.app);
      const me = await signedIn(c, w);
      expect(me).toMatchObject<Partial<MeDTO>>({ tier: 'max' });
      const t = await seedTarget(live.prisma);
      const check = await seedCheck(live.prisma, { targetId: t.id });
      expect((await c.post(`/v1/checks/${check.shortId}/notes`, { text: 'Holder context on this coin.' })).json<NoteDTO>().hold).toBe('3.1M');
    } finally {
      await live.close();
    }
  });
});
