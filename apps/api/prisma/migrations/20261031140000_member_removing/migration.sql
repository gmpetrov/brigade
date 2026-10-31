-- A member being removed from their organization (src/member-remove.ts).
ALTER TABLE "Member" ADD COLUMN "removingAt" TIMESTAMP(3);
