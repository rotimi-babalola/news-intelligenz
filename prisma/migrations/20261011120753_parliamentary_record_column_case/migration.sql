/*
  Warnings:

  - The primary key for the `proceeding_steps` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `apiId` on the `proceeding_steps` table. All the data in the column will be lost.
  - The primary key for the `proceedings` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `apiId` on the `proceedings` table. All the data in the column will be lost.
  - Added the required column `api_id` to the `proceeding_steps` table without a default value. This is not possible if the table is not empty.
  - Added the required column `api_id` to the `proceedings` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "document_references" DROP CONSTRAINT "document_references_step_id_fkey";

-- DropForeignKey
ALTER TABLE "proceeding_step_versions" DROP CONSTRAINT "proceeding_step_versions_step_id_fkey";

-- DropForeignKey
ALTER TABLE "proceeding_versions" DROP CONSTRAINT "proceeding_versions_proceeding_id_fkey";

-- AlterTable
ALTER TABLE "proceeding_steps" DROP CONSTRAINT "proceeding_steps_pkey",
DROP COLUMN "apiId",
ADD COLUMN     "api_id" TEXT NOT NULL,
ADD CONSTRAINT "proceeding_steps_pkey" PRIMARY KEY ("api_id");

-- AlterTable
ALTER TABLE "proceedings" DROP CONSTRAINT "proceedings_pkey",
DROP COLUMN "apiId",
ADD COLUMN     "api_id" TEXT NOT NULL,
ADD CONSTRAINT "proceedings_pkey" PRIMARY KEY ("api_id");

-- AddForeignKey
ALTER TABLE "proceeding_versions" ADD CONSTRAINT "proceeding_versions_proceeding_id_fkey" FOREIGN KEY ("proceeding_id") REFERENCES "proceedings"("api_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proceeding_step_versions" ADD CONSTRAINT "proceeding_step_versions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "proceeding_steps"("api_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "proceeding_steps"("api_id") ON DELETE RESTRICT ON UPDATE CASCADE;
