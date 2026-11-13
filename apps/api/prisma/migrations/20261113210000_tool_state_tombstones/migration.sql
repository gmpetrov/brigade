-- A deleted key of a tool's state stays as a tombstone with its version (src/tools.ts).
ALTER TABLE "ToolState" ADD COLUMN "deletedAt" TIMESTAMP(3);
