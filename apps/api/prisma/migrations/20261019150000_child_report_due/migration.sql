-- A child a person talks with reports once they have been quiet a while (src/children.ts).
ALTER TABLE "Session" ADD COLUMN "reportDueAt" TIMESTAMP(3);

CREATE INDEX "Session_reportDueAt_idx" ON "Session"("reportDueAt");
