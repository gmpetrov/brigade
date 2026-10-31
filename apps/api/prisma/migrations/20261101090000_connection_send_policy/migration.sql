-- A mailbox's rule for the email its teammates send (Brigade's addresses and Gmail alike):
-- auto (they send on their own and leave a person what needs judgment) or approve (each email
-- waits for a person). Every mailbox starts on auto: no teammate had chosen otherwise.
ALTER TABLE "Connection" ADD COLUMN "sendPolicy" TEXT NOT NULL DEFAULT 'auto';
