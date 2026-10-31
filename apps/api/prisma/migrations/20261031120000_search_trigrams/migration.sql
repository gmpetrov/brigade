-- Search finds titles and file names despite a typo (src/routes/search.ts): pg_trgm's
-- word similarity, and trigram indexes that also serve the case-insensitive `contains`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- How close a typed word must be to a word of a title for `<%` (default 0.6). At 0.4,
-- "cecklist", "lanch" or "onbaording" still find their title; exact matches rank first.
-- Without the right to change it, search keeps the default and stays exact-first.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET pg_trgm.word_similarity_threshold = 0.4', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_trgm.word_similarity_threshold left at its default';
END
$$;

-- CreateIndex
CREATE INDEX "Document_path_idx" ON "Document" USING GIN ("path" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "PullRequest_title_idx" ON "PullRequest" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Session_title_idx" ON "Session" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Task_title_idx" ON "Task" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ticket_title_idx" ON "Ticket" USING GIN ("title" gin_trgm_ops);
