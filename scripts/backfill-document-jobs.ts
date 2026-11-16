import { database } from "../src/db.js";
import {
  queueUnprocessedDocuments,
  type QueueUnprocessedDocumentsResult,
} from "../src/dip/documents/backfill.js";

// One-off backfill for references older than the 14-day hot window. It only
// queues work: the document drain (cron or `pnpm drain:dip`) fetches, extracts
// and embeds. Re-running is safe; current variants are skipped.
const dryRun = process.env.DRY_RUN === "1";
const maxAttempts = 3;
const batchSize = Number(process.env.BACKFILL_BATCH_SIZE) || undefined;
let prisma = database();
let cursor = process.env.RESUME_FROM?.trim() || undefined;
let attempt = 0;
let totals: QueueUnprocessedDocumentsResult = {
  queued: 0,
  existing: 0,
  current: 0,
  skipped: 0,
};

function add(
  left: QueueUnprocessedDocumentsResult,
  right: QueueUnprocessedDocumentsResult,
): QueueUnprocessedDocumentsResult {
  return {
    queued: left.queued + right.queued,
    existing: left.existing + right.existing,
    current: left.current + right.current,
    skipped: left.skipped + right.skipped,
  };
}

function isConnectionError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    ["P1001", "P1008", "P1017", "P2024"].includes(code)
  )
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|server closed the connection|connection.*closed/i.test(
    message,
  );
}

function printProgress(
  result: QueueUnprocessedDocumentsResult,
  scanned: number,
  total: number,
) {
  const percent = total ? Math.floor((scanned / total) * 100) : 100;
  const line = `scanned ${scanned}/${total} (${percent}%)  queued=${result.queued} existing=${result.existing} current=${result.current} skipped=${result.skipped}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
  else console.log(line);
}

function endProgressLine() {
  if (process.stdout.isTTY) process.stdout.write("\n");
}

try {
  for (;;) {
    attempt += 1;
    const base = { ...totals };
    let last = base;
    try {
      const result = await queueUnprocessedDocuments(prisma, {
        dryRun,
        batchSize,
        afterReferenceId: cursor,
        onProgress: (progress) => {
          cursor = progress.cursor;
          last = add(base, progress);
          printProgress(last, progress.scanned, progress.total);
        },
      });
      totals = add(base, result);
      break;
    } catch (error) {
      // The partial batch is safe to replay: job creation is idempotent and the
      // next attempt resumes after the last completed batch.
      totals = last;
      if (attempt >= maxAttempts || !isConnectionError(error)) {
        endProgressLine();
        if (cursor)
          console.error(
            `Resume after reference ${cursor} with RESUME_FROM=${cursor} pnpm backfill:document-jobs`,
          );
        throw error;
      }
      endProgressLine();
      console.warn(
        `Connection lost; resuming after reference ${cursor ?? "start"} (attempt ${attempt + 1}/${maxAttempts})`,
      );
      try {
        await prisma.$disconnect();
      } catch {
        // The client is already unusable; open a fresh one below.
      }
      prisma = database();
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  endProgressLine();
  console.log(
    `queued=${totals.queued} existing=${totals.existing} current=${totals.current} skipped=${totals.skipped}${dryRun ? " (dry run)" : ""}`,
  );
} finally {
  await prisma.$disconnect();
}
