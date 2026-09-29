-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('news_feed', 'search_query', 'dip_endpoint');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'claimed', 'retrying', 'succeeded', 'exhausted');

-- AlterTable runs: generic source identity (feed_id stays the source key)
ALTER TABLE "runs" ADD COLUMN "source_kind" "SourceKind" NOT NULL DEFAULT 'news_feed';
ALTER TABLE "runs" ADD COLUMN "source_scope" JSONB;

-- CreateTable processing_jobs
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "source_kind" "SourceKind" NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_scope" JSONB,
    "run_id" TEXT NOT NULL,
    "item_index" INTEGER,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "claimed_by" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable job_attempts
CREATE TABLE "job_attempts" (
    "job_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "error" TEXT,
    "worker_id" TEXT,

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("job_id","attempt_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_dedupe_key_key" ON "processing_jobs"("dedupe_key");
CREATE INDEX "processing_jobs_status_next_attempt_at_idx" ON "processing_jobs"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
