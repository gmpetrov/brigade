-- What threads wrote before src/event-volume.ts counted it: each workspace's days, by the events'
-- own time, and each thread's bytes. A migration of its own, after the one that adds the tables:
-- SessionEvent is read once, into a temporary table, while nothing is locked but what is written.
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

INSERT INTO "ThreadEventVolume" ("organizationId", "workspaceId", "sessionId", "bytes", "largest")
SELECT "organizationId", "workspaceId", "sessionId", sum("bytes"), max("largest")
FROM "event_volume"
GROUP BY 1, 2, 3;

DROP TABLE "event_volume";
