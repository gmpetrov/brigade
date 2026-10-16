-- AlterTable
ALTER TABLE "Session" ADD COLUMN "move" JSONB,
ADD COLUMN "movedAt" TIMESTAMP(3),
ADD COLUMN "movedFrom" TEXT,
ADD COLUMN "movedSeq" INTEGER;
