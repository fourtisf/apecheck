-- AlterTable
ALTER TABLE "Ask" ADD COLUMN     "askerId" TEXT;

-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "fingerprintAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "holding" DECIMAL(38,9),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Watch" ADD COLUMN     "lastAlertAt" TIMESTAMP(3),
ADD COLUMN     "lastRecheckAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "checkId" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Ask_checkId_createdAt_idx" ON "Ask"("checkId", "createdAt");

-- CreateIndex
CREATE INDEX "Ask_askerId_createdAt_idx" ON "Ask"("askerId", "createdAt");

-- CreateIndex
CREATE INDEX "Watch_targetId_idx" ON "Watch"("targetId");

-- AddForeignKey
ALTER TABLE "Ask" ADD CONSTRAINT "Ask_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;
