import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { enqueueJob, jobRow, retryExhausted } from "../../jobs/index";
import {
  EMBED_JOB_BATCH_SIZE,
  EMBED_PROCEEDING,
  EMBED_STEP,
  ON_DEMAND_PRIORITY,
} from "../constants";
import {
  documentEmbeddingIdentity,
  documentJobKey,
  documentProcessingIdentity,
  proceedingEmbeddingIdentity,
  stepEmbeddingIdentity,
  type DocumentJobKeyInput,
} from "./identity";

// Downstream DIP work submits as durable jobs at collection time and runs
// independently: model outages or PDF failures never hold a collection
// checkpoint open, and replaying a run never enqueues twice (dedupeKey).
// Collection only promises the jobs exist exactly once per new record version;
// document processing remains a separate downstream path.

export function enqueueRecordReindex(
  db: PrismaClient,
  input: {
    runId: string;
    model: string;
    operation: typeof EMBED_PROCEEDING | typeof EMBED_STEP;
    rows: { apiId: string; latestVersionNo: number }[];
  },
) {
  const identity =
    input.operation === EMBED_PROCEEDING
      ? proceedingEmbeddingIdentity
      : stepEmbeddingIdentity;
  return db.processingJob.createMany({
    data: input.rows.map((row) =>
      jobRow(
        identity({
          runId: input.runId,
          itemIndex: null,
          electoralTerm: null,
          apiId: row.apiId,
          versionNo: row.latestVersionNo,
          model: input.model,
        }),
      ),
    ),
    skipDuplicates: true,
  });
}

export function enqueueProceedingEmbedding(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number;
    electoralTerm: number;
    apiId: string;
    versionNo: number;
  },
) {
  return enqueueJob(tx, proceedingEmbeddingIdentity(input));
}

export function enqueueStepEmbedding(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number;
    electoralTerm: number;
    apiId: string;
    versionNo: number;
  },
) {
  return enqueueJob(tx, stepEmbeddingIdentity(input));
}

export function enqueueDocumentProcessing(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number | null;
    electoralTerm: number | null;
    stepApiId: string;
    referenceId: string;
    pdfUrl: string | null;
    documentDate: Date | null;
  },
) {
  return enqueueJob(tx, documentProcessingIdentity(input));
}

export async function enqueueDocumentEmbeddings(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number | null;
    electoralTerm: number | null;
    referenceId: string;
    variantNo: number;
    chunks: { pageNo: number; chunkNo: number }[];
    model?: string;
    priority?: number;
  },
) {
  let added = 0;
  for (let i = 0; i < input.chunks.length; i += EMBED_JOB_BATCH_SIZE) {
    const result = await db.processingJob.createMany({
      data: input.chunks.slice(i, i + EMBED_JOB_BATCH_SIZE).map((chunk) =>
        jobRow({
          ...documentEmbeddingIdentity({
            runId: input.runId,
            itemIndex: input.itemIndex,
            electoralTerm: input.electoralTerm,
            referenceId: input.referenceId,
            variantNo: input.variantNo,
            pageNo: chunk.pageNo,
            chunkNo: chunk.chunkNo,
            model: input.model,
          }),
          priority: input.priority ?? 0,
        }),
      ),
      skipDuplicates: true,
    });
    added += result.count;
  }
  return added;
}

// On-demand requests raise the priority of work that already exists instead of
// adding a second job for the same document. Only unprocessed work moves; a
// succeeded document already has its bytes and text cached. An exhausted job
// gets a fresh retry budget every time a person asks for it.
export async function raiseDocumentJob(
  db: PrismaClient | Prisma.TransactionClient,
  reference: DocumentJobKeyInput,
) {
  const key = documentJobKey(reference);
  const job = await db.processingJob.findUnique({ where: { dedupeKey: key } });
  if (!job || job.status === "succeeded") return job;
  if (job.status === "exhausted") {
    await db.processingJob.update({
      where: { id: job.id },
      data: { priority: ON_DEMAND_PRIORITY },
    });
    return retryExhausted(db, job.id);
  }
  return db.processingJob.update({
    where: { id: job.id },
    data: { priority: ON_DEMAND_PRIORITY, nextAttemptAt: new Date() },
  });
}
