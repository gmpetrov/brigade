-- CreateEnum
CREATE TYPE "TeammateKind" AS ENUM ('teammate', 'chief');

-- AlterTable
ALTER TABLE "Teammate" ADD COLUMN     "kind" "TeammateKind" NOT NULL DEFAULT 'teammate';

-- One chief per workspace.
CREATE UNIQUE INDEX "Teammate_one_chief_per_workspace" ON "Teammate"("workspaceId") WHERE "kind" = 'chief';

-- Every existing workspace gets its chief.
INSERT INTO "Teammate" ("id", "organizationId", "workspaceId", "name", "kind", "updatedAt")
SELECT 'c' || substr(md5(random()::text || w."id"), 1, 24), w."organizationId", w."id", 'chief', 'chief', now()
FROM "Workspace" w
WHERE NOT EXISTS (SELECT 1 FROM "Teammate" t WHERE t."workspaceId" = w."id" AND t."kind" = 'chief');
