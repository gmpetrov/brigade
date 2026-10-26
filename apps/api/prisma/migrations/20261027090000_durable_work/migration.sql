-- Durable work (src/held-calls.ts, src/runner-commands.ts, src/inbound.ts): calls held for a
-- decision, commands for runners, triggers' deliveries and vendors' webhooks are rows, not memory.
-- Only adds. Indexes on what is pending only, so the finished rows the sweeps delete cost no index.
-- CreateEnum
CREATE TYPE "HeldCallStatus" AS ENUM ('waiting', 'decided', 'running', 'done', 'expired');

-- CreateEnum
CREATE TYPE "RunnerCommandStatus" AS ENUM ('pending', 'acked', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('pending', 'done', 'failed');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "retryAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HeldCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" "HeldCallStatus" NOT NULL DEFAULT 'waiting',
    "decision" JSONB,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeldCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunnerCommand" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "status" "RunnerCommandStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerDelivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboundEventStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HeldCall_ticketId_key" ON "HeldCall"("ticketId");

-- CreateIndex
CREATE INDEX "HeldCall_sessionId_idx" ON "HeldCall"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerDelivery_triggerId_eventId_key" ON "TriggerDelivery"("triggerId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_source_externalId_key" ON "InboundEvent"("source", "externalId");

-- AddForeignKey
ALTER TABLE "HeldCall" ADD CONSTRAINT "HeldCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeldCall" ADD CONSTRAINT "HeldCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunnerCommand" ADD CONSTRAINT "RunnerCommand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunnerCommand" ADD CONSTRAINT "RunnerCommand_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunnerCommand" ADD CONSTRAINT "RunnerCommand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerDelivery" ADD CONSTRAINT "TriggerDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerDelivery" ADD CONSTRAINT "TriggerDelivery_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "Trigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One waiting call per thread and fingerprint: an identical call joins its ticket.
CREATE UNIQUE INDEX "HeldCall_waiting_fingerprint" ON "HeldCall"("sessionId", "fingerprint") WHERE "status" = 'waiting';

-- Decided calls the minute's tick makes, and calls a restart cut off.
CREATE INDEX "HeldCall_decided_updatedAt" ON "HeldCall"("updatedAt") WHERE "status" IN ('decided', 'running');

-- A computer's commands not acknowledged yet, sent again on hello; and the oldest, given up after a day.
CREATE INDEX "RunnerCommand_pending_computer" ON "RunnerCommand"("computerId", "createdAt") WHERE "status" = 'pending';
CREATE INDEX "RunnerCommand_pending_createdAt" ON "RunnerCommand"("createdAt") WHERE "status" = 'pending';

-- Webhooks to process (again).
CREATE INDEX "InboundEvent_pending_nextAt" ON "InboundEvent"("nextAt") WHERE "status" = 'pending';
