-- PDF-derived text is searchable alongside proceedings and steps, so it needs
-- its own source entity. PostgreSQL can add the enum value inside the migration
-- transaction because no later statement in this migration uses it.
ALTER TYPE "ParliamentaryEntity" ADD VALUE IF NOT EXISTS 'dokument';

-- Page provenance joins the embedding identity: page 0 means "not page-scoped".
DROP INDEX "dip_embeddings_source_version_model_document_key";

ALTER TABLE "dip_embeddings" ADD COLUMN "source_page" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "dip_embeddings_source_version_page_model_document_key"
    ON "dip_embeddings"("source_entity", "source_api_id", "source_version_no", "source_page", "model", "document_instruction");

-- On-demand document requests raise priority instead of duplicating work.
ALTER TABLE "processing_jobs" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "document_contents" (
    "id" UUID NOT NULL,
    "reference_id" TEXT NOT NULL,
    "variant_no" INTEGER NOT NULL,
    "byte_hash" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "page_count" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "source_url" TEXT,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_contents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_contents_variant_no_check" CHECK ("variant_no" > 0)
);

-- CreateTable
CREATE TABLE "document_pages" (
    "content_id" UUID NOT NULL,
    "page_no" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "document_pages_pkey" PRIMARY KEY ("content_id","page_no"),
    CONSTRAINT "document_pages_page_no_check" CHECK ("page_no" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "document_contents_reference_id_byte_hash_key" ON "document_contents"("reference_id", "byte_hash");

-- CreateIndex
CREATE INDEX "document_contents_reference_id_is_latest_idx" ON "document_contents"("reference_id", "is_latest");

-- AddForeignKey
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "document_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
