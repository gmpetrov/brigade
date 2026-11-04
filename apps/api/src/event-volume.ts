// What threads write to SessionEvent, counted as it is stored: by workspace and UTC day
// (WorkspaceEventDay) and by thread (Session.eventBytes). The database's monthly check reads a
// workspace's growth and its largest threads from here rather than read every event again, which
// at a hundred workspaces would be hundreds of GB each time. Sizes are the events' data as the
// database stores it (pg_column_size: compressed when large), what its storage is billed on.
import { prisma } from './db.js'

/**
 * Count the events a thread's checkpoint (lastSeq) just moved over, after `from` up to `to`:
 * each is counted once, as lastSeq moves over it once. In the database, from the rows as stored.
 * Not to hold the thread back: the caller does not wait, and a failure leaves them uncounted.
 */
export async function countEvents(
  session: { id: string; organizationId: string; workspaceId: string },
  from: number,
  to: number,
) {
  if (to <= from) return
  await prisma.$executeRaw`
    WITH "new" AS (
      SELECT count(*)::int AS "events",
             (count(*) FILTER (WHERE "type" = 'message.delta'))::int AS "deltas",
             coalesce(sum(pg_column_size("data")), 0)::bigint AS "bytes",
             coalesce(max(pg_column_size("data")), 0)::int AS "largest"
      FROM "SessionEvent"
      WHERE "sessionId" = ${session.id} AND "seq" > ${from}::int AND "seq" <= ${to}::int
    ), "day" AS (
      INSERT INTO "WorkspaceEventDay" AS d
        ("organizationId", "workspaceId", "day", "events", "deltas", "bytes", "largest")
      SELECT ${session.organizationId}::text, ${session.workspaceId}::text,
             (now() AT TIME ZONE 'UTC')::date, "events", "deltas", "bytes", "largest"
      FROM "new" WHERE "events" > 0
      ON CONFLICT ("workspaceId", "day") DO UPDATE SET
        "events" = d."events" + EXCLUDED."events",
        "deltas" = d."deltas" + EXCLUDED."deltas",
        "bytes" = d."bytes" + EXCLUDED."bytes",
        "largest" = greatest(d."largest", EXCLUDED."largest")
    )
    UPDATE "Session" SET "eventBytes" = "eventBytes" + (SELECT "bytes" FROM "new")
    WHERE "id" = ${session.id}`
}
