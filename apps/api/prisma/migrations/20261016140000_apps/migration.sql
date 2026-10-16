-- CreateEnum
CREATE TYPE "ConnectionReach" AS ENUM ('mine', 'workspace');

-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "App_workspaceId_key_key" ON "App"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: existing connections reach the whole workspace, as before.
ALTER TABLE "Connection" ADD COLUMN "appId" TEXT,
ADD COLUMN "reach" "ConnectionReach" NOT NULL DEFAULT 'workspace';

-- One App per built-in kind per workspace that has a connection of it, its accounts
-- the connections of that kind. Removed connections join too: their call logs stay.
-- The App is credited to whoever connected its first account still connected.
INSERT INTO "App" ("id", "organizationId", "workspaceId", "key", "createdByMemberId", "updatedAt")
SELECT DISTINCT ON ("workspaceId", "kind")
  'app_' || md5("workspaceId" || ':' || "kind"::text), "organizationId", "workspaceId", "kind"::text,
  "createdByMemberId", CURRENT_TIMESTAMP
FROM "Connection"
WHERE "kind" <> 'webhook'
ORDER BY "workspaceId", "kind", "status" = 'removed', "createdAt";

UPDATE "Connection" c SET "appId" = a."id"
FROM "App" a
WHERE c."kind" <> 'webhook' AND a."workspaceId" = c."workspaceId" AND a."key" = c."kind"::text;

-- A custom app is an App of its own, named as the connection was.
INSERT INTO "App" ("id", "organizationId", "workspaceId", "key", "name", "createdByMemberId", "updatedAt")
SELECT 'app_' || md5("id"), "organizationId", "workspaceId", 'custom:' || "id", "label",
  "createdByMemberId", CURRENT_TIMESTAMP
FROM "Connection"
WHERE "kind" = 'webhook';

UPDATE "Connection" SET "appId" = 'app_' || md5("id") WHERE "kind" = 'webhook';

ALTER TABLE "Connection" ALTER COLUMN "appId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Connection_appId_idx" ON "Connection"("appId");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
