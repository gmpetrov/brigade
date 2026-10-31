-- CreateTable
CREATE TABLE "InvitationSend" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvitationSend_organizationId_at_idx" ON "InvitationSend"("organizationId", "at");

-- CreateIndex
CREATE INDEX "InvitationSend_organizationId_email_at_idx" ON "InvitationSend"("organizationId", "email", "at");

-- AddForeignKey
ALTER TABLE "InvitationSend" ADD CONSTRAINT "InvitationSend_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
