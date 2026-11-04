-- Quiet threads' events kept cold, in the bucket (src/cold-events.ts), and what threads write,
-- counted as it is stored (src/event-volume.ts). Only adds, but for one way out of SessionEvent's
-- append-only rule: the transaction that records a chunk of a thread's events, once the bucket
-- holds it, removes those of them it moved.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "coldSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eventBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ColdEventChunk" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "firstSeq" INTEGER NOT NULL,
    "lastSeq" INTEGER NOT NULL,
    "events" INTEGER NOT NULL,
    "moved" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "storedBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColdEventChunk_pkey" PRIMARY KEY ("sessionId","firstSeq")
);

-- CreateTable
CREATE TABLE "WorkspaceEventDay" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 0,
    "deltas" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "largest" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkspaceEventDay_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateIndex
CREATE INDEX "ColdEventChunk_workspaceId_createdAt_idx" ON "ColdEventChunk"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ColdEventChunk" ADD CONSTRAINT "ColdEventChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEventDay" ADD CONSTRAINT "WorkspaceEventDay_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SessionEvent's own append-only rule (AuditEntry and ConnectionCall keep brigade_append_only):
-- rows still go with their thread or workspace (cascade), and otherwise only those a chunk in
-- the bucket holds, removed by the transaction that names the thread it keeps cold
-- (brigade.cold_session). No row is ever changed.
CREATE FUNCTION brigade_session_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD; -- cascade from deleting the parent workspace or thread
  END IF;
  IF TG_OP = 'DELETE'
     AND OLD."sessionId" = current_setting('brigade.cold_session', true)
     AND EXISTS (
       SELECT 1 FROM "ColdEventChunk" c
       WHERE c."sessionId" = OLD."sessionId" AND OLD."seq" BETWEEN c."firstSeq" AND c."lastSeq"
     ) THEN
    RETURN OLD; -- kept cold: the bucket holds it (src/cold-events.ts)
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Last, so that SessionEvent is locked for no longer than these two statements.
DROP TRIGGER "SessionEvent_append_only" ON "SessionEvent";
CREATE TRIGGER "SessionEvent_append_only" BEFORE UPDATE OR DELETE ON "SessionEvent"
  FOR EACH ROW EXECUTE FUNCTION brigade_session_event_append_only();
