-- Apps were called tools: 20261127170000_apps_feature copied the `tools` feature row to `apps`,
-- which every API since reads. The `tools` row is read by nothing now.
DELETE FROM "FeatureFlag" WHERE "key" = 'tools';
