-- CreateTable
CREATE TABLE "InboxState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneByMemberId" TEXT,
    "sessionId" TEXT,
    "handedByMemberId" TEXT,
    "handedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxState_workspaceId_source_doneAt_idx" ON "InboxState"("workspaceId", "source", "doneAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxState_workspaceId_itemId_key" ON "InboxState"("workspaceId", "itemId");

-- AddForeignKey
ALTER TABLE "InboxState" ADD CONSTRAINT "InboxState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxState" ADD CONSTRAINT "InboxState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
