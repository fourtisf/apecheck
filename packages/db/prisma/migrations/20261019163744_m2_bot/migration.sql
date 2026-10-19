-- DropIndex
DROP INDEX "BotMention_checkId_key";

-- AlterTable
ALTER TABLE "BotMention" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "replyText" TEXT,
ADD COLUMN     "targetKey" TEXT;

-- CreateIndex
CREATE INDEX "BotMention_conversationId_idx" ON "BotMention"("conversationId");

-- CreateIndex
CREATE INDEX "BotMention_checkId_idx" ON "BotMention"("checkId");

-- CreateIndex
CREATE INDEX "BotMention_replyTweetId_idx" ON "BotMention"("replyTweetId");
