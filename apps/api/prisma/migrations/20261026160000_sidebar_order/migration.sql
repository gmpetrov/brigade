-- CreateTable
CREATE TABLE "SidebarOrder" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "ids" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SidebarOrder_pkey" PRIMARY KEY ("memberId","workspaceId","list")
);

-- CreateIndex
CREATE INDEX "SidebarOrder_workspaceId_idx" ON "SidebarOrder"("workspaceId");

-- AddForeignKey
ALTER TABLE "SidebarOrder" ADD CONSTRAINT "SidebarOrder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SidebarOrder" ADD CONSTRAINT "SidebarOrder_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
