-- Choices a person dismissed without picking (src/choices-waiting.ts). Only adds: the old API
-- never reads it.
ALTER TABLE "Session" ADD COLUMN "choicesDismissedSeq" INTEGER;
