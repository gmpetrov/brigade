-- Features hidden until they are ready, opened to some people (only adds).
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "everyone" BOOLEAN NOT NULL DEFAULT false,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);
