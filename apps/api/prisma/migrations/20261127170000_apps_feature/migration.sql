-- Tools are now called apps: the `tools` feature becomes `apps`, open to the same people. Only
-- adds: the `tools` row stays for the API before this, and goes in a later change.
INSERT INTO "FeatureFlag" ("key", "everyone", "emails", "workspaceIds", "note", "updatedAt")
SELECT 'apps', "everyone", "emails", "workspaceIds", "note", now()
FROM "FeatureFlag"
WHERE "key" = 'tools'
ON CONFLICT ("key") DO NOTHING;
