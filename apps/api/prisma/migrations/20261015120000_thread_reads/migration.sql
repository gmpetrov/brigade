-- CreateTable
CREATE TABLE "ThreadRead" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadRead_pkey" PRIMARY KEY ("memberId","sessionId")
);

-- CreateIndex
CREATE INDEX "ThreadRead_sessionId_idx" ON "ThreadRead"("sessionId");

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every thread there is now counts as read by every member of its organization: only
-- replies from here on show as unread.
INSERT INTO "ThreadRead" ("organizationId", "workspaceId", "memberId", "sessionId", "seenAt")
SELECT s."organizationId", s."workspaceId", m."id", s."id", CURRENT_TIMESTAMP
FROM "Session" s
JOIN "Member" m ON m."organizationId" = s."organizationId";
