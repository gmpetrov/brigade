-- The sidebar asks which child threads posted a pull request's review (src/routes/threads.ts).
-- Only adds an index.
CREATE INDEX "PullRequestReview_sessionId_idx" ON "PullRequestReview"("sessionId");
