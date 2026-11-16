import { database } from "../src/db.js";
import { queueUnprocessedDocuments } from "../src/dip/documents/backfill.js";

// One-off backfill for references older than the 14-day hot window. It only
// queues work: the document drain (cron or `pnpm drain:dip`) fetches, extracts
// and embeds. Re-running is safe; current variants are skipped.
const prisma = database();
try {
  const result = await queueUnprocessedDocuments(prisma, {
    dryRun: process.env.DRY_RUN === "1",
    batchSize: Number(process.env.BACKFILL_BATCH_SIZE) || undefined,
  });
  console.log(
    `queued=${result.queued} existing=${result.existing} current=${result.current} skipped=${result.skipped}${process.env.DRY_RUN === "1" ? " (dry run)" : ""}`,
  );
} finally {
  await prisma.$disconnect();
}
