-- AlterTable
ALTER TABLE "BotMention" ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "idx" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CoinFacts" ADD COLUMN     "deployerAddress" TEXT;

-- CreateIndex
CREATE INDEX "Claim_checkId_idx_idx" ON "Claim"("checkId", "idx");
