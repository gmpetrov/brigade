-- A cloud computer's disk as its runner last said it while full (src/computer-disk.ts): for
-- Brigade's operators' disk: alert. Members are no longer asked to act on a full disk, which
-- they cannot help with: the tickets that asked them close.
ALTER TABLE "Computer" ADD COLUMN "disk" JSONB;

UPDATE "Ticket" SET "status" = 'resolved', "resolvedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'disk_full' AND "status" = 'open';
