-- A received mail's HTML, apart from MailMessage, for the Inbox's HTML view. Only adds: the old
-- API never reads it.
CREATE TABLE "MailHtml" (
    "mailId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailHtml_pkey" PRIMARY KEY ("mailId")
);

CREATE INDEX "MailHtml_workspaceId_idx" ON "MailHtml"("workspaceId");

ALTER TABLE "MailHtml" ADD CONSTRAINT "MailHtml_mailId_fkey" FOREIGN KEY ("mailId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
