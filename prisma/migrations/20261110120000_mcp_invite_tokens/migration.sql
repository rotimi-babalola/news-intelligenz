CREATE TABLE "mcp_invite_tokens" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "window_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requests_in_window" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "mcp_invite_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_invite_tokens_verifier_key" ON "mcp_invite_tokens"("verifier");
