-- Chief for the person (docs/chief-answers.md): their rules, which teammates working for them
-- read, and Chief's daily pass through what waits on them. Additive: an answer of a pass has no
-- decision thread of its own (childSessionId), and the columns of #724 stay for an older API.

-- CreateEnum
CREATE TYPE "ChiefPassStatus" AS ENUM ('running', 'done', 'failed', 'idle');

-- AlterTable
ALTER TABLE "ChiefDecision" ADD COLUMN     "passId" TEXT,
ALTER COLUMN "childSessionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "chiefPass" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chiefRules" TEXT,
ADD COLUMN     "chiefRulesRefused" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "chiefPassId" TEXT;

-- CreateTable
CREATE TABLE "ChiefPass" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" "ChiefPassStatus" NOT NULL DEFAULT 'running',
    "items" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ChiefPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChiefPass_sessionId_key" ON "ChiefPass"("sessionId");

-- CreateIndex
CREATE INDEX "ChiefPass_status_createdAt_idx" ON "ChiefPass"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChiefPass_memberId_workspaceId_day_key" ON "ChiefPass"("memberId", "workspaceId", "day");

-- CreateIndex
CREATE INDEX "ChiefDecision_passId_idx" ON "ChiefDecision"("passId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_chiefPassId_key" ON "Session"("chiefPassId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_chiefPassId_fkey" FOREIGN KEY ("chiefPassId") REFERENCES "ChiefPass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefDecision" ADD CONSTRAINT "ChiefDecision_passId_fkey" FOREIGN KEY ("passId") REFERENCES "ChiefPass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefPass" ADD CONSTRAINT "ChiefPass_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefPass" ADD CONSTRAINT "ChiefPass_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
