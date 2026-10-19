-- Members order their pinned threads by dragging them (src/routes/threads.ts).
ALTER TABLE "ThreadPin" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
