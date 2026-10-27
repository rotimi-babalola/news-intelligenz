CREATE TABLE "document_chunks" (
    "content_id" UUID NOT NULL,
    "page_no" INTEGER NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("content_id", "page_no", "chunk_no"),
    CONSTRAINT "document_chunks_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "document_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "dip_embeddings" ADD COLUMN "source_chunk" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "dip_embeddings_source_version_page_model_document_key";
CREATE UNIQUE INDEX "dip_embeddings_source_version_page_chunk_model_document_key"
    ON "dip_embeddings"("source_entity", "source_api_id", "source_version_no", "source_page", "source_chunk", "model", "document_instruction");
