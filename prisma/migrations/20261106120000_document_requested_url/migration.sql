ALTER TABLE "document_contents" ADD COLUMN "requested_url" TEXT;

-- Attribute legacy content only when its saved source matches the current reference.
UPDATE "document_contents" AS c
SET "requested_url" = c."source_url"
WHERE EXISTS (
    SELECT 1 FROM "document_references" AS r
    WHERE r."reference_id" = c."reference_id"
      AND r."pdf_url" = c."source_url"
);
