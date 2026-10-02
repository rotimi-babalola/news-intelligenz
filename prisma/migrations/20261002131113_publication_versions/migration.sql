-- AlterTable
ALTER TABLE "processing_jobs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "publications" ADD COLUMN     "extraction_error" TEXT;

-- CreateTable
CREATE TABLE "publication_versions" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "final_url" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publication_versions_publication_id_version_no_key" ON "publication_versions"("publication_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "publication_versions_publication_id_text_hash_key" ON "publication_versions"("publication_id", "text_hash");

-- AddForeignKey
ALTER TABLE "publication_versions" ADD CONSTRAINT "publication_versions_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
