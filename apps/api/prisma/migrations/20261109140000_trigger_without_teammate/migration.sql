-- A mailbox rule may keep its mail for a person, with no teammate (Nobody).
ALTER TABLE "Trigger" ALTER COLUMN "teammateId" DROP NOT NULL;
