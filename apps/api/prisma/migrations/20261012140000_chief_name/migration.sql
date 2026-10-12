-- The chief is shown as "Chief". Mentions match names in any case, so @chief still finds it.
UPDATE "Teammate" SET "name" = 'Chief' WHERE "kind" = 'chief';
