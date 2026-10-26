-- Reconciliation for databases that already applied the first version of the
-- object-key migration, which dropped `bytes` and required `object_key`.
-- Fresh databases get both columns from the migration above; IF NOT EXISTS
-- keeps this migration safe on either history.
ALTER TABLE "document_contents" ADD COLUMN IF NOT EXISTS "bytes" BYTEA;
ALTER TABLE "document_contents" ALTER COLUMN "bytes" DROP NOT NULL;
ALTER TABLE "document_contents" ALTER COLUMN "object_key" DROP NOT NULL;
