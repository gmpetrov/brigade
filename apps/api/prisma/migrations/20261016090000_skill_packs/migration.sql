-- AlterTable
ALTER TABLE "Skill" ADD COLUMN     "packId" TEXT;

-- CreateTable
CREATE TABLE "SkillPack" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "everywhere" BOOLEAN NOT NULL DEFAULT true,
    "teammateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "projectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByType" "ActorType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillPack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillPack_workspaceId_idx" ON "SkillPack"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillPack_workspaceId_source_key" ON "SkillPack"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "Skill_packId_idx" ON "Skill"("packId");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_packId_fkey" FOREIGN KEY ("packId") REFERENCES "SkillPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillPack" ADD CONSTRAINT "SkillPack_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
