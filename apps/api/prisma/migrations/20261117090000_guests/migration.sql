-- Guests (docs/guests.md): accounts Brigade.app makes without a sign-in, until saved with an
-- email. Only adds a column with a default: the API before it keeps working.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "guest" BOOLEAN NOT NULL DEFAULT false;
