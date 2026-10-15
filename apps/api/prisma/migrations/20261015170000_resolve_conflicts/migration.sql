-- AlterEnum
ALTER TYPE "ReviewStatus" ADD VALUE 'resolving';
ALTER TYPE "ReviewStatus" ADD VALUE 'merging';

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "mergeMethod" TEXT;
