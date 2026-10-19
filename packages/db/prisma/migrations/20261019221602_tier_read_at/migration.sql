-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tierReadAt" TIMESTAMP(3);

-- a stored holding was read successfully at tierCheckedAt at the latest (a failed read moves it only to schedule a retry)
UPDATE "User" SET "tierReadAt" = "tierCheckedAt" WHERE "holding" IS NOT NULL AND "tierCheckedAt" IS NOT NULL;
