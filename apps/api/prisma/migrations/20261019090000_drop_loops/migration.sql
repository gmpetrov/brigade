-- Playbooks are reverted (20261018230000_loops stays, as databases applied it): take
-- their columns and tables back out. Dropping a column drops its foreign key and index.

-- AlterTable
ALTER TABLE "ConnectionCall" DROP COLUMN "loopActionKey",
DROP COLUMN "simulated";

-- AlterTable
ALTER TABLE "Schedule" DROP COLUMN "loopInstallationId";

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "loopRunId",
DROP COLUMN "surfacedAt";

-- AlterTable
ALTER TABLE "SkillPack" DROP COLUMN "loopInstallationId";

-- AlterTable
ALTER TABLE "Trigger" DROP COLUMN "loopInstallationId";

-- DropTable
DROP TABLE "LoopRun";

-- DropTable
DROP TABLE "LoopAction";

-- DropTable
DROP TABLE "LoopInstallation";

-- DropEnum
DROP TYPE "LoopRunStatus";

-- DropEnum
DROP TYPE "LoopActionLevel";

-- DropEnum
DROP TYPE "LoopStatus";
