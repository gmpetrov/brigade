-- What remains of a list item: a pull request that is only part of it says what is left once it
-- is merged, added under the item as a line of its own; the item is ticked once all are.
-- AlterTable
ALTER TABLE "ListItem" ADD COLUMN     "remainderOfId" TEXT,
ADD COLUMN     "remainderSettledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ListItemPull" ADD COLUMN     "remains" TEXT,
ADD COLUMN     "remainderId" TEXT;

-- CreateIndex
CREATE INDEX "ListItem_remainderOfId_idx" ON "ListItem"("remainderOfId");
