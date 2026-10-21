import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { coinsByDeployer, deployerCoins } from '../src/deployers';

const prisma = new PrismaClient();

const W = '0xAbCd00000000000000000000000000000000Ef02';
const W_KEY = W.toLowerCase();
const OTHER = '0x2222000000000000000000000000000000002222';
const SOL_W = 'DepSo1aNaWa11et1111111111111111111111111111';

let n = 0;
const ca = () => `0x${(++n).toString(16).padStart(40, 'c')}`;

/** a target, one check of it and its coin facts naming `deployer` */
async function coin(o: {
  chain?: 'BASE' | 'ETH' | 'SOL';
  ca?: string;
  ticker?: string | null;
  kind?: 'COIN' | 'SITE';
  deployer: string | null;
  isPrivate?: boolean;
  status?: 'DONE' | 'RUNNING' | 'FAILED';
  finishedMinutesAgo?: number;
  targetId?: string;
  coinScore?: number;
}) {
  const chain = o.chain ?? 'BASE';
  const contract = o.ca ?? ca();
  const kind = o.kind ?? 'COIN';
  const target = o.targetId
    ? { id: o.targetId }
    : await prisma.target.create({
        data: {
          kind,
          chain,
          ca: contract,
          ticker: o.ticker === undefined ? `T${n}` : o.ticker,
          name: kind === 'SITE' ? `site${n}.xyz` : o.ticker ? `$${o.ticker}` : `$T${n}`,
          key: kind === 'SITE' ? `site:site${n}.xyz` : `ca:${chain.toLowerCase()}:${contract}`,
        },
      });
  const status = o.status ?? 'DONE';
  const check = await prisma.check.create({
    data: {
      shortId: `s${String(++n).padStart(6, '0')}`,
      targetId: target.id,
      targetRaw: contract,
      status,
      isPrivate: o.isPrivate ?? false,
      coinScore: o.coinScore ?? 50,
      coinBand: 'sketchy',
      finishedAt: status === 'RUNNING' ? null : new Date(Date.now() - (o.finishedMinutesAgo ?? 10) * 60_000),
    } as Prisma.CheckUncheckedCreateInput,
  });
  await prisma.coinFacts.create({
    data: {
      checkId: check.id,
      deployerAddress: o.deployer,
      sigDeployer: 'WARN',
      sigBundle: 'WARN',
      sigHolders: 'WARN',
      sigLp: 'WARN',
      sigAuthorities: 'OK',
    },
  });
  return { targetId: target.id, ca: contract, shortId: check.shortId };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "CoinFacts", "Check", "Target" RESTART IDENTITY CASCADE');
});
afterAll(() => prisma.$disconnect());

describe('coinsByDeployer: deployer history from ApeCheck\'s own checks', () => {
  it('finds the coins of the wallet on the same chain; an EVM address matches whatever its case', async () => {
    const a = await coin({ deployer: W_KEY, ticker: 'AAA', finishedMinutesAgo: 30 });
    const b = await coin({ deployer: W_KEY, ticker: 'BBB', finishedMinutesAgo: 5 });
    await coin({ deployer: OTHER, ticker: 'OTH' });
    // the same wallet on another chain is another deployer
    await coin({ chain: 'ETH', deployer: W_KEY, ticker: 'ETHC' });
    const h = await coinsByDeployer(prisma, { chain: 'base', address: W });
    expect(h.total).toBe(2);
    expect(h.coins.map(c => c.ticker)).toEqual(['BBB', 'AAA']);
    expect(h.coins[0]).toMatchObject({ shortId: b.shortId, chain: 'base', ca: b.ca, deployerAddress: W_KEY, coinScore: 50, coinBand: 'sketchy' });
    expect(h.coins[1].shortId).toBe(a.shortId);
    expect((await coinsByDeployer(prisma, { chain: 'eth', address: W })).coins.map(c => c.ticker)).toEqual(['ETHC']);
  });

  it('leaves out the coin itself, private checks and checks that did not finish', async () => {
    const self = await coin({ deployer: W_KEY, ticker: 'SELF' });
    // a website check that found the same coin is the same coin
    await coin({ kind: 'SITE', ca: self.ca.toUpperCase().replace('0X', '0x'), deployer: W_KEY, ticker: 'SELF' });
    await coin({ deployer: W_KEY, ticker: 'PRIV', isPrivate: true });
    await coin({ deployer: W_KEY, ticker: 'RUN', status: 'RUNNING' });
    await coin({ deployer: W_KEY, ticker: 'FAIL', status: 'FAILED' });
    const pub = await coin({ deployer: W_KEY, ticker: 'PUB' });
    const h = await coinsByDeployer(prisma, { chain: 'base', address: W, excludeCa: self.ca });
    expect(h).toMatchObject({ total: 1, coins: [{ shortId: pub.shortId, ticker: 'PUB' }] });
    // the owner's own private checks only when asked for (MCP acting as that user): none here, so still public only
    expect((await deployerCoins(prisma, { chain: 'base', address: W, excludeCa: self.ca })).coins.map(c => c.ticker)).toEqual(['PUB']);
  });

  it('one row per coin: its newest check that names the wallet, a site check and a coin check counted once', async () => {
    const x = await coin({ deployer: W_KEY, ticker: 'XX', finishedMinutesAgo: 60 });
    const newer = await coin({ targetId: x.targetId, ca: x.ca, deployer: W_KEY, finishedMinutesAgo: 1 });
    await coin({ kind: 'SITE', ca: x.ca, deployer: W_KEY, ticker: 'XX', finishedMinutesAgo: 30 });
    const h = await coinsByDeployer(prisma, { chain: 'base', address: W_KEY });
    expect(h.total).toBe(1);
    expect(h.coins[0].shortId).toBe(newer.shortId);
  });

  it('total counts every coin, `take` limits the rows', async () => {
    for (let i = 0; i < 5; i++) await coin({ deployer: W_KEY, finishedMinutesAgo: 10 + i });
    const h = await coinsByDeployer(prisma, { chain: 'base', address: W, take: 2 });
    expect(h.total).toBe(5);
    expect(h.coins).toHaveLength(2);
  });

  it('Solana and Tron wallets are compared as stored (case-sensitive)', async () => {
    await coin({ chain: 'SOL', ca: 'Mint1111111111111111111111111111111111111111', deployer: SOL_W, ticker: 'SOLC' });
    expect((await coinsByDeployer(prisma, { chain: 'sol', address: SOL_W })).total).toBe(1);
    expect((await coinsByDeployer(prisma, { chain: 'sol', address: SOL_W.toLowerCase() })).total).toBe(0);
  });

  it('deployerCoins without a wallet: every coin with a known deployer, one row per coin', async () => {
    await coin({ deployer: W_KEY, ticker: 'A1' });
    await coin({ deployer: OTHER, ticker: 'B1' });
    await coin({ deployer: null, ticker: 'NOD' });
    await coin({ deployer: OTHER, ticker: 'PRV', isPrivate: true });
    const all = await deployerCoins(prisma, { take: 100 });
    expect(all.coins.map(c => `${c.ticker}:${c.deployerAddress}`).sort()).toEqual([`A1:${W_KEY}`, `B1:${OTHER}`]);
  });
});
