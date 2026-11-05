-- Brigade's own skills an admin turned off for the workspace (src/routes/skills.ts, /builtin).
ALTER TABLE "Workspace" ADD COLUMN "builtinSkillsOff" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The library's specs and designs a pull request ships, or is part of (src/decisions.ts).
CREATE TABLE "SpecPull" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "ships" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecPull_pkey" PRIMARY KEY ("documentId","pullRequestId")
);

CREATE INDEX "SpecPull_pullRequestId_idx" ON "SpecPull"("pullRequestId");

ALTER TABLE "SpecPull" ADD CONSTRAINT "SpecPull_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpecPull" ADD CONSTRAINT "SpecPull_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpecPull" ADD CONSTRAINT "SpecPull_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
