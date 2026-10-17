-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "createdByTeammateId" TEXT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByTeammateId_fkey" FOREIGN KEY ("createdByTeammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: tasks a teammate created, from the audit log.
UPDATE "Task" t
SET "createdByTeammateId" = a."actorId"
FROM "AuditEntry" a
WHERE a."action" = 'task.created'
  AND a."targetType" = 'task'
  AND a."targetId" = t."id"
  AND a."actorType" = 'teammate'
  AND EXISTS (SELECT 1 FROM "Teammate" m WHERE m."id" = a."actorId");
