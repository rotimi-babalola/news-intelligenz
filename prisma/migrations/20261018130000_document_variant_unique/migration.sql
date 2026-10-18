-- Two workers can process different revisions of the same document at once.
-- A unique variant number makes the losing transaction retry and recompute
-- instead of leaving two variants that retrieval would join twice.
CREATE UNIQUE INDEX "document_contents_reference_id_variant_no_key"
    ON "document_contents"("reference_id", "variant_no");
