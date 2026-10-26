-- PDF bytes move to object storage (Cloudflare R2). The row keeps the
-- content-addressed key so identical bytes still reuse one variant.
-- Expand only: `bytes` is retained so rows captured before the move can be
-- re-archived, and a null key marks a row that still needs archiving.
ALTER TABLE "document_contents" ADD COLUMN "object_key" TEXT;
