/**
 * Deployer records from DevRadar (HANDOFF §4 Stage D, §13 M3): a daily job that refreshes the Deployer rows of the
 * coins checked in the last DEPLOYER_REFRESH_DAYS days, so the deployers page and the report's deployer line follow
 * new launches and coins that died since the check. Stage D still upserts the row on every check.
 *
 *  - Only with Fourtis configured (FOURTIS_API_URL + FOURTIS_API_KEY): otherwise the job logs once and does nothing
 *    (there is no other source of launch history; the Etherscan creator is not one).
 *  - One DevRadar call per coin: the latest finished public check that assessed a coin (has CoinFacts) of every target
 *    with a chain and contract — a coin checked by its contract, or one a website or X post check found — a few at a
 *    time. A deployer seen for several coins is written once per run (its first answer). Private (Max) checks are
 *    never read: a coin only they checked gets no Deployer row (the deployers page would show that wallet) and none
 *    is linked to them.
 *  - Each answer upserts Deployer(chain, address) with launched, dead, fundedFrom, firstSeen and the record from
 *    core deployerRecord(launched, dead). A coin whose latest report has no Deployer linked yet (the history was
 *    unknown when it was checked) is linked to the row, when DevRadar names the same wallet the check found (or the
 *    check found none), so the coin appears under its deployer. Scores already given are never changed.
 *  - No answer (404, error, timeout) changes nothing.
 */
import { chainFromDb, chainToDb, deployerRecord, recordToDb, type ChainKey } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import type { DevRadarFacts, FourtisSource } from '@apecheck/sources';
import type { Logger } from '../log';
import { pgSafe } from '../pipeline/pgsafe';

export const DEPLOYERS_JOB = 'deployers-refresh';
/** daily, 04:40 UTC (after the 03:20 screenshot cleanup) */
export const DEPLOYERS_PATTERN = '40 4 * * *';
export const DEPLOYER_REFRESH_DAYS = 30;
const MAX_COINS = 2000;
const PARALLEL = 4;

export interface DeployerRefreshDeps {
  prisma: PrismaClient;
  fourtis: FourtisSource;
  log: Logger;
}

export interface DeployerRefreshResult {
  skipped?: 'fourtis not configured';
  coins: number;
  answered: number;
  deployers: number;
  linked: number;
}

const addrKey = (chain: ChainKey, a: string) => (chain === 'sol' || chain === 'trx' ? a : a.toLowerCase());
const asDate = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

export async function refreshDeployers(deps: DeployerRefreshDeps, now = Date.now()): Promise<DeployerRefreshResult> {
  const { prisma, fourtis, log } = deps;
  if (!fourtis.configured) {
    log.info('deployer refresh skipped: Fourtis (DevRadar) is not configured');
    return { skipped: 'fourtis not configured', coins: 0, answered: 0, deployers: 0, linked: 0 };
  }
  const since = new Date(now - DEPLOYER_REFRESH_DAYS * 86_400_000);
  // the latest finished public check that assessed a coin, of every target with one (checked by its contract, or found
  // by a website or X post check: those targets carry the coin's chain and contract too) checked in the window
  const checks = await prisma.check.findMany({
    where: { status: 'DONE', isPrivate: false, finishedAt: { gte: since }, coinFacts: { isNot: null }, target: { chain: { not: null }, ca: { not: null } } },
    orderBy: { finishedAt: 'desc' },
    distinct: ['targetId'],
    take: MAX_COINS,
    select: { id: true, target: { select: { chain: true, ca: true } }, coinFacts: { select: { checkId: true, deployerId: true, deployerAddress: true } } },
  });

  const written = new Map<string, string>(); // "<chain>:<address>" → Deployer.id
  let answered = 0;
  let linked = 0;
  const work = checks.map(c => async () => {
    const chain = chainFromDb(c.target.chain);
    const ca = c.target.ca;
    if (!chain || !ca) return;
    let facts: DevRadarFacts | null = null;
    try {
      facts = await fourtis.devRadar(chain, ca);
    } catch (e) {
      log.warn(`DevRadar ${chain}:${ca} failed`, e);
    }
    if (!facts?.deployer) return;
    answered++;
    const address = addrKey(chain, facts.deployer);
    const key = `${chain}:${address}`;
    let deployerId = written.get(key);
    if (!deployerId) {
      const launched = Math.max(0, Math.round(facts.launched));
      const dead = Math.min(launched, Math.max(0, Math.round(facts.dead)));
      const fields = {
        record: recordToDb(deployerRecord(launched, dead)),
        launched,
        dead,
        fundedFrom: facts.fundedFrom ?? null,
        firstSeen: asDate(facts.firstSeen),
      };
      const dbChain = chainToDb(chain)!;
      const row = await prisma.deployer.upsert({
        where: { chain_address: { chain: dbChain, address } },
        create: pgSafe({ chain: dbChain, address, ...fields }),
        update: pgSafe(fields),
        select: { id: true },
      });
      deployerId = row.id;
      written.set(key, deployerId);
    }
    const f = c.coinFacts;
    if (f && !f.deployerId && (!f.deployerAddress || addrKey(chain, f.deployerAddress) === address)) {
      await prisma.coinFacts.update({ where: { checkId: f.checkId }, data: { deployerId, deployerAddress: f.deployerAddress ?? address } });
      linked++;
    }
  });
  // a few DevRadar calls at a time
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, work.length) }, async () => {
      while (next < work.length) {
        const job = work[next++];
        await job().catch(e => log.warn('deployer refresh: one coin failed', e));
      }
    }),
  );
  log.info(`deployer refresh: ${answered}/${checks.length} coins answered by DevRadar, ${written.size} deployers updated, ${linked} coins linked`);
  return { coins: checks.length, answered, deployers: written.size, linked };
}
