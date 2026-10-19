/**
 * The browser suite's data: a few sites, coins on two chains, a post check that read its post, a check that
 * stopped before a verdict, and deployers on Base and Solana. Fixed short ids so tests can name rows.
 */
import type { openDb } from './env';

type Db = Awaited<ReturnType<typeof openDb>>;

const TABLES = [
  'NoteVote', 'Note', 'Ask', 'BotMention', 'Watch', 'ApiKey', 'Webhook', 'PricePoint',
  'CoinFacts', 'Claim', 'CheckStep', 'Check', 'Deployer', 'Target', 'User',
];

const NAR = (n: number) => (n >= 80 ? 'real' : n >= 60 ? 'likely' : n >= 40 ? 'partly' : n >= 20 ? 'llarp' : 'larp');
const COIN = (n: number) => (n >= 80 ? 'clean' : n >= 60 ? 'ok' : n >= 35 ? 'sketchy' : 'rigged');

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Sites, newest first: nebula.fi is the most real. */
export const SITES = [
  { id: 'site001', domain: 'orbitswap.xyz', nar: 72, ago: 30 },
  { id: 'site002', domain: 'kairo.app', nar: 35, ago: 60 },
  { id: 'site003', domain: 'nebula.fi', nar: 88, ago: 90 },
] as const;

/** Coins: two sketchy ones on Solana, the rest elsewhere or in other bands. */
export const COINS = [
  { id: 'coin001', ticker: 'ORBT', chain: 'SOL', coin: 44, nar: 50, ago: 20 },
  { id: 'coin002', ticker: 'BASED', chain: 'BASE', coin: 82, nar: 70, ago: 40 },
  { id: 'coin003', ticker: 'RUG', chain: 'SOL', coin: 18, nar: 20, ago: 50 },
  { id: 'coin004', ticker: 'MEH', chain: 'SOL', coin: 41, nar: 45, ago: 70 },
  { id: 'coin005', ticker: 'BLUE', chain: 'BASE', coin: 40, nar: 55, ago: 80 },
] as const;

/** Deployers: on Base the serial launcher has the most dead tokens. */
export const DEPLOYERS = [
  { chain: 'BASE', address: '0x1111111111111111111111111111111111111111', record: 'BUILDER', launched: 3, dead: 0 },
  { chain: 'BASE', address: '0x2222222222222222222222222222222222222222', record: 'SERIAL', launched: 9, dead: 7 },
  { chain: 'SOL', address: 'So1Dep1oyerAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', record: 'MIXED', launched: 4, dead: 2 },
  { chain: 'SOL', address: 'So1Dep1oyerBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', record: 'SERIAL', launched: 12, dead: 11 },
] as const;

export const POST_CHECK = { id: 'post001', handle: 'kairolabs', text: 'Kairo v2 is live on mainnet today. Try it.' } as const;
export const FAILED_CHECK = { id: 'revfai1', domain: 'crashy.xyz' } as const;
export const BOT_CHECK = { id: 'bot0001', mentionBy: 'degen_rina', mentionText: '@ApeCheckBot is this real? @kairolabs' } as const;

export async function seed(db: Db) {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

  for (const s of SITES) {
    const t = await db.target.create({ data: { kind: 'SITE', domain: s.domain, name: s.domain, key: `site:${s.domain}`, checkCount: 1 } });
    await db.check.create({
      data: {
        shortId: s.id, targetId: t.id, targetRaw: s.domain, status: 'DONE', via: 'WEB', isLatest: true,
        narScore: s.nar, totalScore: s.nar, narBand: NAR(s.nar), summary: `What the agent found on ${s.domain}.`,
        createdAt: minutesAgo(s.ago + 2), startedAt: minutesAgo(s.ago + 2), finishedAt: minutesAgo(s.ago), durationMs: 90_000,
      },
    });
  }

  for (const c of COINS) {
    const ca = `${c.ticker}Mint1111111111111111111111111111111111`.slice(0, 44);
    const t = await db.target.create({
      data: { kind: 'COIN', chain: c.chain, ca, ticker: c.ticker, name: `$${c.ticker}`, key: `ca:${c.chain.toLowerCase()}:${ca}`, checkCount: 1 },
    });
    const check = await db.check.create({
      data: {
        shortId: c.id, targetId: t.id, targetRaw: ca, status: 'DONE', via: 'WEB', isLatest: true,
        narScore: c.nar, coinScore: c.coin, totalScore: Math.round((c.nar + c.coin) / 2), narBand: NAR(c.nar), coinBand: COIN(c.coin),
        summary: `What the agent found on $${c.ticker}.`,
        createdAt: minutesAgo(c.ago + 2), startedAt: minutesAgo(c.ago + 2), finishedAt: minutesAgo(c.ago), durationMs: 90_000,
      },
    });
    await db.coinFacts.create({
      data: { checkId: check.id, sigDeployer: 'WARN', sigBundle: 'OK', sigHolders: 'WARN', sigLp: 'OK', sigAuthorities: 'OK', top10Pct: 31, holders: 812 },
    });
  }

  for (const d of DEPLOYERS) {
    await db.deployer.create({ data: { ...d, firstSeen: new Date('2025-06-01T00:00:00Z') } });
  }

  const post = await db.target.create({
    data: { kind: 'POST', handle: POST_CHECK.handle, name: `@${POST_CHECK.handle}`, key: 'post:1849', checkCount: 1 },
  });
  await db.check.create({
    data: {
      shortId: POST_CHECK.id, targetId: post.id, targetRaw: `https://x.com/${POST_CHECK.handle}/status/1849`, postId: '1849', status: 'DONE', via: 'WEB',
      isLatest: true, narScore: 37, totalScore: 37, narBand: NAR(37), summary: 'The post says live; the app stops at a waitlist.',
      evidence: { post: { id: '1849', author: POST_CHECK.handle, authorId: '42', text: POST_CHECK.text, createdAt: minutesAgo(600).toISOString() } },
      createdAt: minutesAgo(12), startedAt: minutesAgo(12), finishedAt: minutesAgo(10), durationMs: 90_000,
    },
  });

  const crashy = await db.target.create({ data: { kind: 'SITE', domain: FAILED_CHECK.domain, name: FAILED_CHECK.domain, key: `site:${FAILED_CHECK.domain}`, checkCount: 1 } });
  const failed = await db.check.create({
    data: {
      shortId: FAILED_CHECK.id, targetId: crashy.id, targetRaw: FAILED_CHECK.domain, status: 'FAILED', via: 'WEB', isLatest: false,
      error: 'The check stopped early.', createdAt: minutesAgo(8), startedAt: minutesAgo(8), finishedAt: minutesAgo(7), durationMs: 41_000,
    },
  });
  await db.checkStep.createMany({
    data: [
      { checkId: failed.id, idx: 0, tMs: 0, status: 'INFO', text: `Opening ${FAILED_CHECK.domain}` },
      { checkId: failed.id, idx: 1, tMs: 4000, status: 'FAIL', text: 'The browser crashed' },
    ],
  });
}

/** A check the bot ran for the post, with its reply posted on X (what M2 stores), or nothing when `posted` is false. */
export async function seedBotReply(db: Db, posted: boolean) {
  await db.botMention.deleteMany({});
  await db.check.deleteMany({ where: { shortId: BOT_CHECK.id } });
  if (!posted) return;
  const post = await db.target.findUniqueOrThrow({ where: { key: 'post:1849' } });
  // the bot's check becomes the post's latest verdict
  await db.check.updateMany({ where: { targetId: post.id }, data: { isLatest: false } });
  const c = await db.check.create({
    data: {
      shortId: BOT_CHECK.id, targetId: post.id, targetRaw: `https://x.com/${POST_CHECK.handle}/status/1849`, postId: '1849', status: 'DONE', via: 'BOT',
      requesterHandle: BOT_CHECK.mentionBy, isLatest: true, narScore: 37, totalScore: 37, narBand: NAR(37), summary: 'The post says live; the app stops at a waitlist.',
      evidence: { post: { id: '1849', author: POST_CHECK.handle, authorId: '42', text: POST_CHECK.text, createdAt: minutesAgo(600).toISOString() } },
      createdAt: minutesAgo(6), startedAt: minutesAgo(6), finishedAt: minutesAgo(4), durationMs: 90_000,
    },
  });
  await db.botMention.create({
    data: {
      tweetId: '9001', authorId: '77', authorHandle: BOT_CHECK.mentionBy, text: BOT_CHECK.mentionText, inReplyToId: '1849', status: 'REPLIED',
      checkId: c.id, replyTweetId: '9002', repliedAt: minutesAgo(3), createdAt: minutesAgo(6),
    },
  });
}

/** Undo seedBotReply(db, true): the site's post check is the latest verdict again. */
export async function clearBotReply(db: Db) {
  await seedBotReply(db, false);
  const post = await db.target.findUniqueOrThrow({ where: { key: 'post:1849' } });
  await db.check.updateMany({ where: { targetId: post.id, shortId: POST_CHECK.id }, data: { isLatest: true } });
}
