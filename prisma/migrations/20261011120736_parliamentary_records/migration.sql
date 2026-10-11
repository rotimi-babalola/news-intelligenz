-- CreateEnum
CREATE TYPE "ParliamentaryEntity" AS ENUM ('vorgang', 'vorgangsposition');

-- CreateTable
CREATE TABLE "proceedings" (
    "apiId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "proceeding_type" TEXT NOT NULL,
    "electoral_term" INTEGER NOT NULL,
    "deliberation_state" TEXT,
    "document_date" DATE,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latest_version_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "proceedings_pkey" PRIMARY KEY ("apiId")
);

-- CreateTable
CREATE TABLE "proceeding_versions" (
    "id" UUID NOT NULL,
    "proceeding_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" TEXT,

    CONSTRAINT "proceeding_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proceeding_steps" (
    "apiId" TEXT NOT NULL,
    "proceeding_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "step_label" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_date" DATE,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latest_version_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "proceeding_steps_pkey" PRIMARY KEY ("apiId")
);

-- CreateTable
CREATE TABLE "proceeding_step_versions" (
    "id" UUID NOT NULL,
    "step_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" TEXT,

    CONSTRAINT "proceeding_step_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_references" (
    "step_id" TEXT NOT NULL,
    "proceeding_id" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "pdf_url" TEXT NOT NULL,
    "document_date" DATE,
    "metadata" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_references_pkey" PRIMARY KEY ("step_id")
);

-- CreateTable
CREATE TABLE "parliamentary_discoveries" (
    "run_id" TEXT NOT NULL,
    "entity" "ParliamentaryEntity" NOT NULL,
    "api_id" TEXT NOT NULL,
    "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parliamentary_discoveries_pkey" PRIMARY KEY ("run_id","entity","api_id")
);

-- CreateTable
CREATE TABLE "dip_checkpoints" (
    "endpoint" TEXT NOT NULL,
    "electoral_term" INTEGER NOT NULL,
    "updated_through" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dip_checkpoints_pkey" PRIMARY KEY ("endpoint","electoral_term")
);

-- CreateIndex
CREATE UNIQUE INDEX "proceeding_versions_proceeding_id_version_no_key" ON "proceeding_versions"("proceeding_id", "version_no");

-- CreateIndex
CREATE INDEX "proceeding_steps_proceeding_id_idx" ON "proceeding_steps"("proceeding_id");

-- CreateIndex
CREATE UNIQUE INDEX "proceeding_step_versions_step_id_version_no_key" ON "proceeding_step_versions"("step_id", "version_no");

-- CreateIndex
CREATE INDEX "document_references_proceeding_id_idx" ON "document_references"("proceeding_id");

-- CreateIndex
CREATE INDEX "document_references_reference_id_idx" ON "document_references"("reference_id");

-- CreateIndex
CREATE INDEX "parliamentary_discoveries_entity_api_id_idx" ON "parliamentary_discoveries"("entity", "api_id");

-- AddForeignKey
ALTER TABLE "proceeding_versions" ADD CONSTRAINT "proceeding_versions_proceeding_id_fkey" FOREIGN KEY ("proceeding_id") REFERENCES "proceedings"("apiId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proceeding_step_versions" ADD CONSTRAINT "proceeding_step_versions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "proceeding_steps"("apiId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "proceeding_steps"("apiId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parliamentary_discoveries" ADD CONSTRAINT "parliamentary_discoveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
