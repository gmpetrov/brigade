-- AlterTable
ALTER TABLE "MailMessage" ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "doneAt" TIMESTAMP(3),
ADD COLUMN     "doneByMemberId" TEXT,
ADD COLUMN     "handedByMemberId" TEXT,
ADD COLUMN     "sourceId" TEXT,
ALTER COLUMN "addressId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "MailMessage_workspaceId_direction_receivedAt_idx" ON "MailMessage"("workspaceId", "direction", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_box_sourceId_key" ON "MailMessage"("box", "sourceId");

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "inbox" BOOLEAN NOT NULL DEFAULT false;

