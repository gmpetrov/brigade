-- Tools (docs/tools.md): state they keep, and App accounts attached to them.
CREATE TABLE "ToolState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ToolAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "access" "GrantScope" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attachedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolState_toolId_owner_key_key" ON "ToolState"("toolId", "owner", "key");
CREATE INDEX "ToolState_workspaceId_idx" ON "ToolState"("workspaceId");
CREATE UNIQUE INDEX "ToolAccount_toolId_connectionId_key" ON "ToolAccount"("toolId", "connectionId");
CREATE INDEX "ToolAccount_workspaceId_idx" ON "ToolAccount"("workspaceId");

ALTER TABLE "ToolState" ADD CONSTRAINT "ToolState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolState" ADD CONSTRAINT "ToolState_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolAccount" ADD CONSTRAINT "ToolAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolAccount" ADD CONSTRAINT "ToolAccount_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolAccount" ADD CONSTRAINT "ToolAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
