-- Child threads, schedule runs among them, are in their top thread's project.
WITH RECURSIVE "tree" AS (
  SELECT p."id", p."projectId" AS "rootProjectId"
  FROM "Session" p
  WHERE p."parentId" IS NULL
    AND EXISTS (SELECT 1 FROM "Session" c WHERE c."parentId" = p."id")
  UNION ALL
  SELECT s."id", t."rootProjectId"
  FROM "Session" s
  JOIN "tree" t ON s."parentId" = t."id"
)
UPDATE "Session" s
SET "projectId" = t."rootProjectId"
FROM "tree" t
WHERE s."id" = t."id"
  AND s."parentId" IS NOT NULL
  AND s."projectId" IS DISTINCT FROM t."rootProjectId";

-- A schedule reporting to a thread is in that thread's project.
UPDATE "Schedule" sc
SET "projectId" = p."projectId"
FROM "Session" p
WHERE sc."parentSessionId" = p."id"
  AND sc."projectId" IS DISTINCT FROM p."projectId";
