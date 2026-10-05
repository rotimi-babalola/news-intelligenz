-- CreateEnum
CREATE TYPE "RelevanceDecision" AS ENUM ('accepted', 'uncertain', 'rejected');

-- CreateTable
CREATE TABLE "relevance_reviews" (
    "run_id" TEXT NOT NULL,
    "item_index" INTEGER NOT NULL,
    "decision" "RelevanceDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relevance_reviews_pkey" PRIMARY KEY ("run_id","item_index")
);
