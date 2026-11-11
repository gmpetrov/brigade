-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('proposed', 'declined', 'superseded', 'active', 'paused', 'achieved', 'ended');

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'proposed',
    "contract" JSONB NOT NULL,
    "revoked" JSONB NOT NULL DEFAULT '[]',
    "approvedByMemberId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "decidedByMemberId" TEXT,
    "turnSeq" INTEGER NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "stalledTurns" INTEGER NOT NULL DEFAULT 0,
    "best" DOUBLE PRECISION,
    "nextMeasureAt" TIMESTAMP(3),
    "heldUntil" TIMESTAMP(3),
    "holdReason" TEXT,
    "driftWokeAt" TIMESTAMP(3),
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalMeasurement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "value" DOUBLE PRECISION,
    "met" BOOLEAN,
    "detail" TEXT,
    "turnSeq" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measuredAt" TIMESTAMP(3),

    CONSTRAINT "GoalMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_sessionId_status_idx" ON "Goal"("sessionId", "status");

-- CreateIndex
CREATE INDEX "Goal_status_nextMeasureAt_idx" ON "Goal"("status", "nextMeasureAt");

-- CreateIndex
CREATE INDEX "GoalMeasurement_goalId_at_idx" ON "GoalMeasurement"("goalId", "at");

-- CreateIndex
CREATE INDEX "GoalMeasurement_status_at_idx" ON "GoalMeasurement"("status", "at");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalMeasurement" ADD CONSTRAINT "GoalMeasurement_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One goal at a time in a thread: proposed, active or paused (docs/goals.md).
CREATE UNIQUE INDEX "Goal_one_open_per_thread" ON "Goal"("sessionId") WHERE "status" IN ('proposed', 'active', 'paused');
