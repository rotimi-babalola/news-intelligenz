-- The claim's ORDER BY priority DESC, next_attempt_at, created_at.
-- Partial because only ready rows belong in that order: a full index starts
-- every claim at the oldest settled row and walks the whole history first.
-- Prisma cannot express a partial index, so this one lives only here.
CREATE INDEX IF NOT EXISTS "processing_jobs_claim_idx" ON "processing_jobs" ("priority" DESC, "next_attempt_at", "created_at")
WHERE "status" IN ('pending', 'retrying');
