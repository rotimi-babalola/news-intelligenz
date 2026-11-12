CREATE TABLE "proceeding_briefs" (
    "key" TEXT NOT NULL,
    "proceeding_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "proceeding_briefs_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "proceeding_briefs_proceeding_id_language_idx" ON "proceeding_briefs"("proceeding_id", "language");
