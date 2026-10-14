CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE "dip_embeddings" (
    "id" UUID NOT NULL,
    "source_entity" "ParliamentaryEntity" NOT NULL,
    "source_api_id" TEXT NOT NULL,
    "source_version_no" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "document_instruction" TEXT NOT NULL,
    "query_instruction" TEXT NOT NULL,
    "embedding" public.vector(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dip_embeddings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dip_embeddings_source_version_no_check" CHECK ("source_version_no" > 0)
);

CREATE UNIQUE INDEX "dip_embeddings_source_entity_source_api_id_source_version_no_model_document_instruction_query_instruction_key"
    ON "dip_embeddings"("source_entity", "source_api_id", "source_version_no", "model", "document_instruction", "query_instruction");
