-- The Tasks board is gone (docs/hand-offs.md). Only additions: the Task table and Session.taskId stay
-- until a later deploy, once no API running reads them.

-- A thread a teammate started from another (start_thread), which that one may still write in.
ALTER TABLE "Session" ADD COLUMN "startedFromId" TEXT;
CREATE INDEX "Session_startedFromId_idx" ON "Session"("startedFromId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_startedFromId_fkey" FOREIGN KEY ("startedFromId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A task's thread whose task was done is a thread done: the Board and the lists read only the
-- thread's own done now. By whoever completed the task (its latest task.completed), else Brigade.
WITH completed AS (
  SELECT DISTINCT ON ("targetId") "targetId" AS "taskId", "actorType", "actorId"
  FROM "AuditEntry"
  WHERE "targetType" = 'task' AND "action" = 'task.completed'
  ORDER BY "targetId", "at" DESC
)
UPDATE "Session" AS s
SET "doneAt" = t."completedAt",
    "doneSummary" = COALESCE(s."doneSummary", NULLIF(LEFT(BTRIM(REGEXP_REPLACE(t."summary", '\s+', ' ', 'g')), 300), '')),
    "doneByType" = COALESCE(c."actorType", 'system'),
    "doneById" = COALESCE(c."actorId", 'brigade')
FROM "Task" AS t
LEFT JOIN completed AS c ON c."taskId" = t."id"
WHERE s."taskId" = t."id" AND t."completedAt" IS NOT NULL AND s."doneAt" IS NULL;
