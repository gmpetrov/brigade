-- CreateTable
CREATE TABLE "BucketCleanup" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BucketCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BucketCleanup_sessionId_key" ON "BucketCleanup"("sessionId");

-- CreateIndex
CREATE INDEX "BucketCleanup_notBefore_idx" ON "BucketCleanup"("notBefore");
