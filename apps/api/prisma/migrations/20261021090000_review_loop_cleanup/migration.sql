-- What 20261020200000_reviews_in_child_threads kept for the API deployed before it goes: the
-- review loop's columns, which no running code reads any more, and its values of the merge
-- status's type, which no running code writes. Deploy only once that migration's API runs.

-- AlterTable
ALTER TABLE "PullRequest" DROP COLUMN "autoMerge",
DROP COLUMN "reviewerTeammateId";

-- Anything left in the loop's values is no merge under way.
UPDATE "PullRequest" SET "reviewStatus" = 'none'
WHERE "reviewStatus" IN ('reviewing', 'fixing', 'approved', 'changes_requested');

-- AlterEnum: the same type name, with only a merge's values.
ALTER TYPE "ReviewStatus" RENAME TO "ReviewStatus_old";
CREATE TYPE "ReviewStatus" AS ENUM ('none', 'stuck', 'resolving', 'merging');
ALTER TABLE "PullRequest" ALTER COLUMN "reviewStatus" DROP DEFAULT;
ALTER TABLE "PullRequest" ALTER COLUMN "reviewStatus" TYPE "ReviewStatus" USING ("reviewStatus"::text::"ReviewStatus");
ALTER TABLE "PullRequest" ALTER COLUMN "reviewStatus" SET DEFAULT 'none';
DROP TYPE "ReviewStatus_old";
