-- Where a visitor who downloaded Brigade.app from the site came from (src/download-source.ts),
-- kept a few days for their app's guest sign-up. Only adds a table.
-- CreateTable
CREATE TABLE "DownloadSource" (
    "visitor" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DownloadSource_pkey" PRIMARY KEY ("visitor")
);

-- CreateIndex
CREATE INDEX "DownloadSource_createdAt_idx" ON "DownloadSource"("createdAt");
