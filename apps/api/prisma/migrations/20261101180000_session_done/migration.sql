-- A thread's work declared done (docs/board.md). Only adds: the old API never reads them.
ALTER TABLE "Session" ADD COLUMN "doneAt" TIMESTAMP(3),
ADD COLUMN "doneSummary" TEXT,
ADD COLUMN "doneByType" "ActorType",
ADD COLUMN "doneById" TEXT;

CREATE INDEX "Session_workspaceId_doneAt_idx" ON "Session"("workspaceId", "doneAt");
