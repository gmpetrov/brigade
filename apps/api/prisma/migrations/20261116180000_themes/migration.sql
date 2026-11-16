-- Themes (docs/themes.md): a member's own looks for the dashboard, their files in the bucket and
-- their last look changes. Only adds tables: the API before it keeps working.
-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThemeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "count" INTEGER,
    "byTeammateId" TEXT,
    "byName" TEXT,
    "wornSlug" TEXT,
    "wornFile" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThemeChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Theme_workspaceId_idx" ON "Theme"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Theme_memberId_workspaceId_slug_key" ON "Theme"("memberId", "workspaceId", "slug");

-- CreateIndex
CREATE INDEX "ThemeAsset_themeId_name_idx" ON "ThemeAsset"("themeId", "name");

-- CreateIndex
CREATE INDEX "ThemeAsset_workspaceId_idx" ON "ThemeAsset"("workspaceId");

-- CreateIndex
CREATE INDEX "ThemeChange_workspaceId_idx" ON "ThemeChange"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeChange_memberId_workspaceId_seq_key" ON "ThemeChange"("memberId", "workspaceId", "seq");

-- AddForeignKey
ALTER TABLE "Theme" ADD CONSTRAINT "Theme_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Theme" ADD CONSTRAINT "Theme_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeAsset" ADD CONSTRAINT "ThemeAsset_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeChange" ADD CONSTRAINT "ThemeChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeChange" ADD CONSTRAINT "ThemeChange_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
