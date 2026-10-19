-- AlterTable
-- M2: the author typed the bot's handle (set by the worker when it stores the mention); /v1/bot/stats counts
-- only these authors, not people talking in a thread the bot is in, retweets of a tag, or the bot itself
ALTER TABLE "BotMention" ADD COLUMN     "tagged" BOOLEAN NOT NULL DEFAULT false;

-- Backfill rows stored before the column: "text" holds what the author typed (X's reply prefix left out), so a
-- tag is the default handle (X_BOT_HANDLE = ApeCheckBot) written in it, either at sign, case-insensitive
UPDATE "BotMention" SET "tagged" = true
WHERE ("ignoreReason" IS NULL OR "ignoreReason" NOT IN ('self', 'retweet', 'not_tagged'))
  AND "text" ~* '(^|[^A-Za-z0-9_@＠])[@＠]ApeCheckBot([^A-Za-z0-9_]|$)';
