DELETE FROM "dip_embeddings" AS embedding
USING (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY source_entity, source_api_id, source_version_no, model, document_instruction
        ORDER BY created_at DESC, id DESC
    ) AS duplicate_no
    FROM "dip_embeddings"
) AS duplicate
WHERE embedding.id = duplicate.id AND duplicate.duplicate_no > 1;

DROP INDEX "dip_embeddings_source_entity_source_api_id_source_version_no_mo";
ALTER TABLE "dip_embeddings" DROP COLUMN "query_instruction";

CREATE UNIQUE INDEX "dip_embeddings_source_version_model_document_key"
    ON "dip_embeddings"("source_entity", "source_api_id", "source_version_no", "model", "document_instruction");
