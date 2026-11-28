-- Agent swarms (docs/sub-threads.md): a sub-thread's tree, and whether each of its reports wakes
-- its parent. Only adds: older APIs read and write neither.
ALTER TABLE "Session" ADD COLUMN "rootId" TEXT;
ALTER TABLE "Session" ADD COLUMN "wakeEach" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Session_rootId_idx" ON "Session"("rootId");
