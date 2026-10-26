import { database } from "../src/db.js";
import { backfillDocumentObjects } from "../src/dip/backfill.js";

// One-off repair for rows written before PDF bytes moved to object storage.
// Re-running is safe: rows that already have a key are never selected.
const prisma = database();
try {
  const result = await backfillDocumentObjects(prisma, {
    dryRun: process.env.DRY_RUN === "1",
    batchSize: Number(process.env.BACKFILL_BATCH_SIZE) || undefined,
  });
  console.log(
    `archived=${result.archived} skipped=${result.skipped} failed=${result.failed}${process.env.DRY_RUN === "1" ? " (dry run)" : ""}`,
  );
  if (result.failed) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
