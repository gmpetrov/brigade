-- A workspace deleted on its own (src/workspace-delete.ts) closes only itself to Checkout.
ALTER TABLE "BillingClosing" ADD COLUMN "workspaceId" TEXT;

-- A deleted workspace's folder in the bucket, emptied until nothing is left.
CREATE TABLE "WorkspaceCleanup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceCleanup_workspaceId_key" ON "WorkspaceCleanup"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceCleanup_notBefore_idx" ON "WorkspaceCleanup"("notBefore");
