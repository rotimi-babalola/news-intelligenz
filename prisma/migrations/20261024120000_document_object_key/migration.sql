-- PDF bytes move to object storage (Cloudflare R2). The row keeps the
-- content-addressed key so identical bytes still reuse one variant.
-- Existing rows predate the move and are local fixtures only; an empty key
-- marks a cache entry with no archived object. New rows always set it.
ALTER TABLE "document_contents" ADD COLUMN "object_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "document_contents" ALTER COLUMN "object_key" DROP DEFAULT;
ALTER TABLE "document_contents" DROP COLUMN "bytes";
