-- Chief no longer reads each question a teammate ends on (docs/chief-answers.md): off for every
-- member, those who had it on by the former default included. Each may still turn it on again in
-- Preferences until it is replaced.
UPDATE "Member" SET "chiefAnswers" = false WHERE "chiefAnswers" = true;
