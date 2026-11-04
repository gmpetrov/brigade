-- What threads wrote before src/event-volume.ts counted it: each workspace's days, by the events'
-- own time, and each thread's bytes. A migration of its own, after the one that adds the columns,
-- so that Session is not locked while SessionEvent is read: read once into a temporary table,
-- then written, Session last.
CREATE TEMP TABLE "event_volume" AS
SELECT "organizationId", "workspaceId", "sessionId", "at"::date AS "day",
       count(*)::int AS "events",
       (count(*) FILTER (WHERE "type" = 'message.delta'))::int AS "deltas",
       sum(pg_column_size("data"))::bigint AS "bytes",
       max(pg_column_size("data"))::int AS "largest"
FROM "SessionEvent"
GROUP BY 1, 2, 3, 4;

INSERT INTO "WorkspaceEventDay" ("organizationId", "workspaceId", "day", "events", "deltas", "bytes", "largest")
SELECT "organizationId", "workspaceId", "day", sum("events"), sum("deltas"), sum("bytes"), max("largest")
FROM "event_volume"
GROUP BY 1, 2, 3;

UPDATE "Session" s SET "eventBytes" = v."bytes"
FROM (SELECT "sessionId", sum("bytes")::bigint AS "bytes" FROM "event_volume" GROUP BY 1) v
WHERE v."sessionId" = s."id";

DROP TABLE "event_volume";
