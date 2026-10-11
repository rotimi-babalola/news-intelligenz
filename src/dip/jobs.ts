import type { Prisma } from "../generated/prisma/client";
import { dipSource, enqueueJob } from "../jobs";

// Downstream DIP work submits as durable jobs at collection time and runs
// independently: model outages or PDF failures never hold a collection
// checkpoint open, and replaying a run never enqueues twice (dedupeKey).
// The workers themselves arrive in later slices; collection only promises
// the jobs exist exactly once per new record version.

export const EMBED_PROCEEDING = "embed_proceeding";
export const EMBED_STEP = "embed_step";
export const PROCESS_DOCUMENT = "process_document";

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
    operation: EMBED_STEP,
    payload: { apiId: input.apiId, versionNo: input.versionNo },
  });
}

export function enqueueDocumentProcessing(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    itemIndex: number;
    electoralTerm: number;
    stepApiId: string;
    referenceId: string;
    pdfUrl: string | null;
  },
) {
  return enqueueJob(tx, {
    source: dipSource("/vorgangsposition", String(input.electoralTerm)),
    runId: input.runId,
    itemIndex: input.itemIndex,
    operation: PROCESS_DOCUMENT,
    payload: {
      stepApiId: input.stepApiId,
      referenceId: input.referenceId,
      pdfUrl: input.pdfUrl,
    },
  });
}
