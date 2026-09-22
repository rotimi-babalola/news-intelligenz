-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('de', 'en');

-- CreateEnum
CREATE TYPE "IdentifierKind" AS ENUM ('guid', 'url');

-- CreateEnum
CREATE TYPE "ContentAvailability" AS ENUM ('metadata_only', 'full_text');

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "feed_id" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "status" "RunStatus" NOT NULL,
    "valid_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "publisher" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "original_url" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "language" "Language" NOT NULL,
    "content_availability" "ContentAvailability" NOT NULL DEFAULT 'metadata_only',
    "first_discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_identifiers" (
    "publisher" TEXT NOT NULL,
    "kind" "IdentifierKind" NOT NULL,
    "value" TEXT NOT NULL,
    "publication_id" UUID NOT NULL,

    CONSTRAINT "publication_identifiers_pkey" PRIMARY KEY ("publisher","kind","value")
);

-- CreateTable
CREATE TABLE "candidates" (
    "run_id" TEXT NOT NULL,
    "item_index" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "publication_id" UUID,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("run_id","item_index")
);

-- CreateTable
CREATE TABLE "discoveries" (
    "run_id" TEXT NOT NULL,
    "publication_id" UUID NOT NULL,
    "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discoveries_pkey" PRIMARY KEY ("run_id","publication_id")
);

-- AddForeignKey
ALTER TABLE "publication_identifiers" ADD CONSTRAINT "publication_identifiers_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
