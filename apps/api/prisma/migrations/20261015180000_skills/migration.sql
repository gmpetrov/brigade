-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "everywhere" BOOLEAN NOT NULL DEFAULT true,
    "teammateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "projectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByType" "ActorType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedByType" "ActorType" NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Skill_workspaceId_idx" ON "Skill"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_workspaceId_name_key" ON "Skill"("workspaceId", "name");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
