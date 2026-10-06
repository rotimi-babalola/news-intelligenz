CREATE TABLE "search_provider_calls" (
    "id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_provider_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "search_provider_calls_provider_started_at_idx"
ON "search_provider_calls"("provider", "started_at");

CREATE UNIQUE INDEX "search_provider_calls_run_id_key"
ON "search_provider_calls"("run_id");
