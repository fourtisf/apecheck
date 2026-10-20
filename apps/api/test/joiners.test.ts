/**
 * M4: a Max user whose POST /v1/checks (site session or API key; MCP run_check goes through the same createCheck) joins
 * a check of the same project already running is recorded in Redis (checkJoinersKey + CHECK_JOINED_INDEX), so the
 * worker sends them its check.completed webhooks too ("a check you started finished"). Nobody else is recorded: not
 * the requester of a new check, not a Free or Pro user, not a request answered with a cached verdict.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_JOINED_INDEX, CHECK_JOINERS_TTL_S, checkJoinersKey, type CreateApiKeyResponse, type CreateCheckResponse } from '@apecheck/core';
import { Client, EvmWallet, makeHarness, resetState, signedIn, type Harness } from './helpers';

const maxW = new EvmWallet();
const proW = new EvmWallet();

describe('joining a running check (check.completed for joiners)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max,${proW.address}:pro` });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  const internalId = async (shortId: string) => (await h.prisma.check.findUniqueOrThrow({ where: { shortId } })).id;

  it('records a Max joiner (session or API key) once; Free and Pro joiners, cached answers and own new checks are not', async () => {
    // someone anonymous starts it
    const anon = await new Client(h.app).post('/v1/checks', { target: 'joined.xyz' });
    expect(anon.statusCode).toBe(201);
    const started = anon.json<CreateCheckResponse>();
    const id = await internalId(started.id);

    // a Max developer asks for the same project with an API key: the running check, and they are recorded
    const max = new Client(h.app);
    const me = await signedIn(max, maxW);
    const userId = me.user!.id;
    const key = (await max.post('/v1/keys', {})).json<CreateApiKeyResponse>().key;
    const joined = await new Client(h.app).post('/v1/checks', { target: 'joined.xyz' }, { authorization: `Bearer ${key}` });
    expect(joined.statusCode).toBe(200);
    expect(joined.json<CreateCheckResponse>()).toMatchObject({ id: started.id, cached: false });
    expect(await h.redis.smembers(checkJoinersKey(id))).toEqual([userId]);
    const ttl = await h.redis.ttl(checkJoinersKey(id));
    expect(ttl).toBeGreaterThan(CHECK_JOINERS_TTL_S - 60);
    expect(ttl).toBeLessThanOrEqual(CHECK_JOINERS_TTL_S);
    expect(Number(await h.redis.zscore(CHECK_JOINED_INDEX, id))).toBeGreaterThan(Date.now() - 60_000);

    // the same user again on the site: still one member
    expect((await max.post('/v1/checks', { target: 'joined.xyz' })).statusCode).toBe(200);
    expect(await h.redis.smembers(checkJoinersKey(id))).toEqual([userId]);

    // Pro and Free users can't have webhooks: not recorded
    const pro = new Client(h.app);
    await signedIn(pro, proW);
    expect((await pro.post('/v1/checks', { target: 'joined.xyz' })).statusCode).toBe(200);
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    expect((await free.post('/v1/checks', { target: 'joined.xyz' })).statusCode).toBe(200);
    expect(await h.redis.smembers(checkJoinersKey(id))).toEqual([userId]);

    // a recent verdict (cached: true) is not a check finishing later: nothing recorded
    await h.prisma.check.update({ where: { id }, data: { status: 'DONE', finishedAt: new Date(), narScore: 48, narBand: 'partly' } });
    await h.redis.del(checkJoinersKey(id), CHECK_JOINED_INDEX);
    const cached = await max.post('/v1/checks', { target: 'joined.xyz' });
    expect(cached.json<CreateCheckResponse>()).toMatchObject({ id: started.id, cached: true });
    expect(await h.redis.exists(checkJoinersKey(id), CHECK_JOINED_INDEX)).toBe(0);

    // their own new check: they are its requester, nothing to record
    const own = await max.post('/v1/checks', { target: 'own.xyz' });
    expect(own.statusCode).toBe(201);
    const ownId = await internalId(own.json<CreateCheckResponse>().id);
    expect((await h.prisma.check.findUniqueOrThrow({ where: { id: ownId } })).requesterId).toBe(userId);
    expect(await h.redis.exists(checkJoinersKey(ownId), CHECK_JOINED_INDEX)).toBe(0);
  });
});
