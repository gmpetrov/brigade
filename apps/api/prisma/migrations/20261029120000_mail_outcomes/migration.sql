-- AlterTable
ALTER TABLE "MailMessage" ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "outcomeAskedAt" TIMESTAMP(3),
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "outcomeNote" TEXT,
ADD COLUMN     "sentByMemberId" TEXT;
