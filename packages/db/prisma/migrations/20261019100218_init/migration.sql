-- CreateEnum
CREATE TYPE "TargetKind" AS ENUM ('COIN', 'POST', 'SITE');

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('SOL', 'ETH', 'BASE', 'BNB', 'ARB', 'RH', 'TRX');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "Via" AS ENUM ('WEB', 'BOT', 'API');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('INFO', 'OK', 'WARN', 'FAIL');

-- CreateEnum
CREATE TYPE "Signal" AS ENUM ('OK', 'WARN', 'FAIL');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SEEN_WORKING', 'NOT_SEEN', 'CONTRADICTED', 'CHECKS_OUT');

-- CreateEnum
CREATE TYPE "DeployerRecord" AS ENUM ('BUILDER', 'MIXED', 'SERIAL');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('FREE', 'PRO', 'MAX');

-- CreateEnum
CREATE TYPE "MentionStatus" AS ENUM ('RECEIVED', 'IGNORED', 'QUEUED', 'REPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "Target" (
    "id" TEXT NOT NULL,
    "kind" "TargetKind" NOT NULL,
    "chain" "Chain",
    "ca" TEXT,
    "domain" TEXT,
    "handle" TEXT,
    "ticker" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastPrice" DECIMAL(38,18),
    "lastMc" DECIMAL(24,2),
    "lastVol5m" DECIMAL(24,2),
    "lastCh24" DOUBLE PRECISION,
    "priceUpdatedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "Target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "shortId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetRaw" TEXT NOT NULL,
    "postId" TEXT,
    "status" "CheckStatus" NOT NULL DEFAULT 'QUEUED',
    "via" "Via" NOT NULL DEFAULT 'WEB',
    "requesterId" TEXT,
    "requesterHandle" TEXT,
    "requesterSid" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "isLatest" BOOLEAN NOT NULL DEFAULT false,
    "sigLaunch" "Signal",
    "sigFlow" "Signal",
    "sigDocs" "Signal",
    "sigAcct" "Signal",
    "sigGit" "Signal",
    "evidence" JSONB,
    "narScore" INTEGER,
    "coinScore" INTEGER,
    "totalScore" INTEGER,
    "narBand" TEXT,
    "coinBand" TEXT,
    "areas" JSONB,
    "summary" TEXT,
    "coinSummary" TEXT,
    "durationMs" INTEGER,
    "error" TEXT,
    "priceAtCheck" DECIMAL(38,18),
    "mcAtCheck" DECIMAL(24,2),
    "asksCount" INTEGER NOT NULL DEFAULT 0,
    "cardPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckStep" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "tMs" INTEGER NOT NULL,
    "status" "StepStatus" NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT,
    "url" TEXT,
    "caption" TEXT,
    "screenshot" TEXT,

    CONSTRAINT "CheckStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL,
    "evidence" TEXT NOT NULL,
    "stepIdx" INTEGER,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinFacts" (
    "checkId" TEXT NOT NULL,
    "deployerId" TEXT,
    "sigDeployer" "Signal" NOT NULL,
    "sigBundle" "Signal" NOT NULL,
    "sigHolders" "Signal" NOT NULL,
    "sigLp" "Signal" NOT NULL,
    "sigAuthorities" "Signal" NOT NULL,
    "bundlePct" DOUBLE PRECISION,
    "bundleWallets" INTEGER,
    "top10Pct" DOUBLE PRECISION,
    "devHoldPct" DOUBLE PRECISION,
    "lpStatus" TEXT,
    "authorities" TEXT,
    "holders" INTEGER,
    "liquidityUsd" DECIMAL(24,2),
    "pairCreatedAt" TIMESTAMP(3),

    CONSTRAINT "CoinFacts_pkey" PRIMARY KEY ("checkId")
);

-- CreateTable
CREATE TABLE "Deployer" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "record" "DeployerRecord" NOT NULL,
    "launched" INTEGER NOT NULL DEFAULT 0,
    "dead" INTEGER NOT NULL DEFAULT 0,
    "fundedFrom" TEXT,
    "firstSeen" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "mc" DECIMAL(24,2),
    "vol5m" DECIMAL(24,2),

    CONSTRAINT "PricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "evmAddress" TEXT,
    "solAddress" TEXT,
    "xHandle" TEXT,
    "xUserId" TEXT,
    "tier" "Tier" NOT NULL DEFAULT 'FREE',
    "tierCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watch" (
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("userId","targetId")
);

-- CreateTable
CREATE TABLE "Ask" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "askerHandle" TEXT,
    "via" "Via" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "helpful" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteVote" (
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "NoteVote_pkey" PRIMARY KEY ("noteId","userId")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotMention" (
    "id" TEXT NOT NULL,
    "tweetId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorHandle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "inReplyToId" TEXT,
    "conversationId" TEXT,
    "isFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "status" "MentionStatus" NOT NULL DEFAULT 'RECEIVED',
    "ignoreReason" TEXT,
    "checkId" TEXT,
    "replyTweetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Target_key_key" ON "Target"("key");

-- CreateIndex
CREATE INDEX "Target_ca_idx" ON "Target"("ca");

-- CreateIndex
CREATE INDEX "Target_domain_idx" ON "Target"("domain");

-- CreateIndex
CREATE INDEX "Target_handle_idx" ON "Target"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Check_shortId_key" ON "Check"("shortId");

-- CreateIndex
CREATE INDEX "Check_status_finishedAt_idx" ON "Check"("status", "finishedAt");

-- CreateIndex
CREATE INDEX "Check_targetId_finishedAt_idx" ON "Check"("targetId", "finishedAt");

-- CreateIndex
CREATE INDEX "Check_narBand_idx" ON "Check"("narBand");

-- CreateIndex
CREATE INDEX "Check_coinBand_idx" ON "Check"("coinBand");

-- CreateIndex
CREATE INDEX "Check_isLatest_finishedAt_idx" ON "Check"("isLatest", "finishedAt");

-- CreateIndex
CREATE INDEX "Check_requesterSid_idx" ON "Check"("requesterSid");

-- CreateIndex
CREATE INDEX "Check_via_finishedAt_idx" ON "Check"("via", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckStep_checkId_idx_key" ON "CheckStep"("checkId", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "Deployer_chain_address_key" ON "Deployer"("chain", "address");

-- CreateIndex
CREATE INDEX "PricePoint_targetId_ts_idx" ON "PricePoint"("targetId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "User_evmAddress_key" ON "User"("evmAddress");

-- CreateIndex
CREATE UNIQUE INDEX "User_solAddress_key" ON "User"("solAddress");

-- CreateIndex
CREATE UNIQUE INDEX "User_xHandle_key" ON "User"("xHandle");

-- CreateIndex
CREATE UNIQUE INDEX "User_xUserId_key" ON "User"("xUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "BotMention_tweetId_key" ON "BotMention"("tweetId");

-- CreateIndex
CREATE UNIQUE INDEX "BotMention_checkId_key" ON "BotMention"("checkId");

-- CreateIndex
CREATE INDEX "BotMention_authorId_createdAt_idx" ON "BotMention"("authorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckStep" ADD CONSTRAINT "CheckStep_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinFacts" ADD CONSTRAINT "CoinFacts_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinFacts" ADD CONSTRAINT "CoinFacts_deployerId_fkey" FOREIGN KEY ("deployerId") REFERENCES "Deployer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricePoint" ADD CONSTRAINT "PricePoint_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ask" ADD CONSTRAINT "Ask_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteVote" ADD CONSTRAINT "NoteVote_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteVote" ADD CONSTRAINT "NoteVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotMention" ADD CONSTRAINT "BotMention_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE SET NULL ON UPDATE CASCADE;
