-- AlterTable
-- M2: the users X would add to the bot's reply besides the asker (sent as reply.exclude_reply_user_ids)
ALTER TABLE "BotMention" ADD COLUMN     "replyExcludeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
