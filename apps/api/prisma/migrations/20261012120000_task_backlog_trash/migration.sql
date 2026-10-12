-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_teammateId_fkey";

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "trashedAt" TIMESTAMP(3),
ALTER COLUMN "teammateId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Task_workspaceId_trashedAt_idx" ON "Task"("workspaceId", "trashedAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A teammate is assigned when the thread starts: a backlog task has none.
UPDATE "Task" SET "teammateId" = NULL
WHERE NOT EXISTS (SELECT 1 FROM "Session" s WHERE s."taskId" = "Task"."id");
