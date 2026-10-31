-- The member whose request a thread's teammate works on now (src/thread-spec.ts, askedBy).
ALTER TABLE "Session" ADD COLUMN "askedByMemberId" TEXT;
