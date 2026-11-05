-- Chief answers for the person (docs/chief-answers.md): its decisions, and each member's settings. Only additions.
-- CreateEnum
CREATE TYPE "ChiefDecisionStatus" AS ENUM ('pending', 'suggested', 'answered', 'escalated', 'superseded', 'failed');

-- CreateEnum
CREATE TYPE "ChiefOutcome" AS ENUM ('agreed', 'disagreed', 'overruled');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "chiefAnswers" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "chiefAuto" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "chiefAutoChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "chiefDecisionId" TEXT,
ADD COLUMN     "chiefWordAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChiefDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "askSeq" INTEGER NOT NULL,
    "question" TEXT,
    "options" JSONB NOT NULL,
    "childSessionId" TEXT NOT NULL,
    "status" "ChiefDecisionStatus" NOT NULL DEFAULT 'pending',
    "verdict" TEXT,
    "kind" TEXT,
    "optionIndex" INTEGER,
    "reason" TEXT,
    "basis" TEXT,
    "parked" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" "ChiefOutcome",
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChiefDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChiefDecision_childSessionId_key" ON "ChiefDecision"("childSessionId");

-- CreateIndex
CREATE INDEX "ChiefDecision_memberId_kind_outcomeAt_idx" ON "ChiefDecision"("memberId", "kind", "outcomeAt");

-- CreateIndex
CREATE INDEX "ChiefDecision_status_createdAt_idx" ON "ChiefDecision"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChiefDecision_sessionId_askSeq_key" ON "ChiefDecision"("sessionId", "askSeq");

-- CreateIndex
CREATE UNIQUE INDEX "Session_chiefDecisionId_key" ON "Session"("chiefDecisionId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_chiefDecisionId_fkey" FOREIGN KEY ("chiefDecisionId") REFERENCES "ChiefDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefDecision" ADD CONSTRAINT "ChiefDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefDecision" ADD CONSTRAINT "ChiefDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChiefDecision" ADD CONSTRAINT "ChiefDecision_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

