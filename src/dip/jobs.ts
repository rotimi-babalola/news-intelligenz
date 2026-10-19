import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { dipSource, enqueueJob, retryExhausted } from "../jobs";

// Downstream DIP work submits as durable jobs at collection time and runs
// independently: model outages or PDF failures never hold a collection
// checkpoint open, and replaying a run never enqueues twice (dedupeKey).
// Collection only promises the jobs exist exactly once per new record version;
// document processing remains a separate downstream path.

export const EMBED_PROCEEDING = "embed_proceeding";
export const EMBED_STEP = "embed_step";
export const EMBED_DOCUMENT = "embed_document";
export const PROCESS_DOCUMENT = "process_document";

// Background document work waits for nothing; an on-demand request jumps the
// queue by priority without pre-empting a claim already in flight.
export const ON_DEMAND_PRIORITY = 10;

function dipJobKey(
  runId: string,
  operation: string,
  apiId: string,
  version: number | string,
) {
  return JSON.stringify([runId, operation, apiId, version]);
}

// Document work is keyed by the document it processes rather than the run that
// noticed it, so the background hot subset and an on-demand request converge
// on one job. A changed reference (url or date) is a new revision and gets its
// own job; identical bytes are recognised from the cache at processing time.
export function documentJobKey(input: {
  referenceId: string;
  pdfUrl: string | null;
  documentDate: Date | null;
}) {
  return JSON.stringify([
    PROCESS_DOCUMENT,
    input.referenceId,
    input.pdfUrl,
    input.documentDate?.toISOString() ?? null,
  ]);
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
  return enqueueJob(tx, {
    source: dipSource("/vorgang", String(input.electoralTerm)),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: dipJobKey(
      input.runId,
      EMBED_PROCEEDING,
      input.apiId,
      input.versionNo,
    ),
    operation: EMBED_PROCEEDING,
    payload: { apiId: input.apiId, versionNo: input.versionNo },
  });
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
  return enqueueJob(tx, {
    source: dipSource("/vorgangsposition", String(input.electoralTerm)),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: dipJobKey(input.runId, EMBED_STEP, input.apiId, input.versionNo),
    operation: EMBED_STEP,
    payload: { apiId: input.apiId, versionNo: input.versionNo },
  });
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
  return enqueueJob(tx, {
    source: dipSource(
      "/vorgangsposition",
      input.electoralTerm === null ? undefined : String(input.electoralTerm),
    ),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: documentJobKey(input),
    operation: PROCESS_DOCUMENT,
    payload: {
      stepApiId: input.stepApiId,
      referenceId: input.referenceId,
      pdfUrl: input.pdfUrl,
      ...(input.electoralTerm === null
        ? {}
        : { electoralTerm: input.electoralTerm }),
    },
  });
}

// Page embeddings run as their own durable job per document variant page, so
// a model outage retries one page without re-downloading or re-extracting.
export function enqueueDocumentEmbedding(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number | null;
    electoralTerm: number | null;
    referenceId: string;
    variantNo: number;
    pageNo: number;
    priority?: number;
  },
) {
  return enqueueJob(tx, {
    source: dipSource(
      "/vorgangsposition",
      input.electoralTerm === null ? undefined : String(input.electoralTerm),
    ),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: JSON.stringify([
      EMBED_DOCUMENT,
      input.referenceId,
      input.variantNo,
      input.pageNo,
    ]),
    operation: EMBED_DOCUMENT,
    payload: {
      referenceId: input.referenceId,
      variantNo: input.variantNo,
      pageNo: input.pageNo,
    },
    priority: input.priority,
  });
}

// On-demand requests raise the priority of work that already exists instead of
// adding a second job for the same document. Only unprocessed work moves; a
// succeeded document already has its bytes and text cached. An exhausted job
// gets a fresh retry budget every time a person asks for it.
export async function raiseDocumentJob(
  db: PrismaClient | Prisma.TransactionClient,
  key: string,
) {
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
