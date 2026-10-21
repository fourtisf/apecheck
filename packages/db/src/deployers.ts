/**
 * Deployer history from ApeCheck's own checks (no third-party source): the coins ApeCheck has checked whose deployer
 * wallet is the given one. The wallet is CoinFacts.deployerAddress, which the worker stores keyed with core
 * deployerKey() (EVM: the Etherscan contract creator, lowercased; Tron: the contract's origin address; Solana
 * deployers are not looked up).
 *
 *  - One row per coin: its contract on its chain, so a website or X post check that found a coin and a check of the
 *    coin itself count once. The row is that coin's newest finished check naming the wallet.
 *  - Public checks only (unless `viewerId` adds that user's own private ones): a wallet only a private check named is
 *    never listed, and a privately vetted coin never shows up in anyone else's history.
 *  - Only coins someone checked on ApeCheck are counted, so it is a lower bound: shown, never scored.
 */
import { chainFromDb, chainToDb, deployerKey, type ChainKey } from '@apecheck/core';
import { Prisma, type PrismaClient } from '@prisma/client';

export interface DeployerCoinRow {
  checkId: string;
  shortId: string;
  targetId: string;
  chain: ChainKey;
  /** the coin's contract as the Target stores it */
  ca: string;
  /** CoinFacts.deployerAddress (deployerKey form) */
  deployerAddress: string;
  name: string;
  ticker: string | null;
  /** Target.key, for the avatar hue */
  key: string;
  /** Target.logo ("logos/<sha256>.<ext>"), null until one was stored */
  logo: string | null;
  narScore: number | null;
  coinScore: number | null;
  totalScore: number | null;
  narBand: string | null;
  coinBand: string | null;
  finishedAt: Date;
}

export interface DeployerCoinsQuery {
  /** only coins on this chain */
  chain?: ChainKey | null;
  /** only this wallet (compared in deployerKey form: pass `chain` with it, or an EVM 0x address is lowercased) */
  address?: string | null;
  /** leave out this coin (its contract on `chain`): the coin whose history is being shown */
  excludeCa?: string | null;
  /** also that user's own private checks (MCP deployer_history acting as the key's owner) */
  viewerId?: string | null;
  /** most rows returned, newest first (`total` still counts them all) */
  take?: number;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The coin a row is about: the contract, lowercased on EVM chains (like deployerKey). */
const COIN_KEY = Prisma.sql`CASE WHEN t."chain" IN ('SOL', 'TRX') THEN t."ca" ELSE lower(t."ca") END`;

/** Rows as described in the header, newest check first, with the number of coins before `take` cut them. */
export async function deployerCoins(prisma: PrismaClient, q: DeployerCoinsQuery = {}): Promise<{ total: number; coins: DeployerCoinRow[] }> {
  const take = Math.max(0, Math.min(Math.round(q.take ?? 50), 10_000));
  const conds: Prisma.Sql[] = [
    Prisma.sql`c."status" = 'DONE'`,
    Prisma.sql`c."finishedAt" IS NOT NULL`,
    Prisma.sql`t."chain" IS NOT NULL`,
    Prisma.sql`t."ca" IS NOT NULL`,
    Prisma.sql`f."deployerAddress" IS NOT NULL`,
    q.viewerId
      ? Prisma.sql`(c."isPrivate" = false OR c."requesterId" = ${q.viewerId})`
      : Prisma.sql`c."isPrivate" = false`,
  ];
  if (q.chain) conds.push(Prisma.sql`t."chain"::text = ${chainToDb(q.chain)}`);
  if (q.address) {
    const address = q.chain ? deployerKey(q.chain, q.address) : EVM_ADDRESS_RE.test(q.address) ? q.address.toLowerCase() : q.address;
    conds.push(Prisma.sql`f."deployerAddress" = ${address}`);
  }
  if (q.excludeCa && q.chain) conds.push(Prisma.sql`${COIN_KEY} <> ${deployerKey(q.chain, q.excludeCa)}`);
  if (!take) return { total: 0, coins: [] };

  const rows = await prisma.$queryRaw<(Omit<DeployerCoinRow, 'chain'> & { chain: string; total: bigint })[]>`
    SELECT x.*, count(*) OVER () AS "total" FROM (
      SELECT DISTINCT ON (t."chain", ${COIN_KEY})
        c."id" AS "checkId", c."shortId", c."targetId", t."chain"::text AS "chain", t."ca", f."deployerAddress",
        t."name", t."ticker", t."key", t."logo", c."narScore", c."coinScore", c."totalScore", c."narBand", c."coinBand", c."finishedAt"
      FROM "CoinFacts" f
      JOIN "Check" c ON c."id" = f."checkId"
      JOIN "Target" t ON t."id" = c."targetId"
      WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY t."chain", ${COIN_KEY}, c."finishedAt" DESC, c."id" DESC
    ) x
    ORDER BY x."finishedAt" DESC, x."checkId" DESC
    LIMIT ${take}`;
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    coins: rows.map(({ total: _total, chain, ...r }) => ({ ...r, chain: chainFromDb(chain as Parameters<typeof chainFromDb>[0])! })),
  };
}

/**
 * The other coins from `address` on `chain` that ApeCheck has checked (public checks only), leaving out the coin
 * whose history this is. Newest first, at most `take`; `total` counts them all.
 */
export function coinsByDeployer(
  prisma: PrismaClient,
  q: { chain: ChainKey; address: string; excludeCa?: string | null; take?: number },
): Promise<{ total: number; coins: DeployerCoinRow[] }> {
  return deployerCoins(prisma, { chain: q.chain, address: q.address, excludeCa: q.excludeCa ?? null, take: q.take ?? 50 });
}
