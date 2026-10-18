import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { claimNextJob, completeJob, failJob } from "../jobs";
import {
  documentJobKey,
  enqueueDocumentEmbedding,
  enqueueDocumentProcessing,
  PROCESS_DOCUMENT,
  raiseDocumentJob,
} from "./jobs";
import { fetchDocumentPdf, pymupdfExtractor, type PageExtractor } from "./pdf";
import {
  createDocumentContent,
  createDocumentPages,
  findDocumentContentByHash,
  findDocumentReferenceById,
  latestDocumentContent,
  latestStepDiscovery,
  supersedeDocumentContents,
} from "./repository";

// PDF processing is downstream of DIP collection and never part of it: the
// document job fetches bytes, caches a content variant, extracts page text and
// hands embedding to its own durable job. A failure here leaves the source
// reference, its metadata and its original link intact and never holds an
// endpoint checkpoint open.
//
// shortcut: permanent-looking failures (missing url, 404, unreadable PDF) use
// the full bounded retry budget. Split a permanent-failure path once document
// volume makes repeated fetches costly.

export type ProcessDocumentOptions = {
  fetchPdf?: typeof fetchDocumentPdf;
  extract?: PageExtractor;
  jobId?: string;
};

export async function processNextDocument(
  prisma: PrismaClient,
  workerId: string,
  options: ProcessDocumentOptions = {},
) {
  const job = await claimNextJob(prisma, workerId, undefined, {
    operation: PROCESS_DOCUMENT,
    jobId: options.jobId,
  });
  if (!job) return { status: "empty" as const };
  try {
    const payload = job.payload as {
      referenceId?: unknown;
      pdfUrl?: unknown;
      electoralTerm?: unknown;
    };
    if (typeof payload.referenceId !== "string")
      throw new Error("Document job is missing its reference");
    const electoralTerm =
      typeof payload.electoralTerm === "number" ? payload.electoralTerm : null;
    const referenceId = payload.referenceId;
    const pdfUrl = typeof payload.pdfUrl === "string" ? payload.pdfUrl : null;
    if (!pdfUrl) throw new Error("Document reference has no pdf_url");

    const fetched = await (options.fetchPdf ?? fetchDocumentPdf)(pdfUrl);
    if (!fetched.ok)
      throw new Error(`Document fetch failed: ${fetched.reason}`);
    const byteHash = createHash("sha256").update(fetched.bytes).digest("hex");

    // Identical bytes are the same content variant: reuse the cached row and
    // skip extraction entirely. Changed bytes become a new retained variant.
    let content = await findDocumentContentByHash(
      prisma,
      referenceId,
      byteHash,
    );
    const reused = content !== null;
    if (!content) {
      const pages = await (options.extract ?? pymupdfExtractor)(fetched.bytes);
      content = await prisma.$transaction(async (tx) => {
        const latest = await latestDocumentContent(tx, referenceId);
        await supersedeDocumentContents(tx, referenceId);
        const stored = await createDocumentContent(tx, {
          referenceId,
          variantNo: (latest?.variantNo ?? 0) + 1,
          byteHash,
          byteSize: fetched.bytes.byteLength,
          pageCount: pages.length,
          bytes: new Uint8Array(fetched.bytes),
          sourceUrl: fetched.finalUrl,
        });
        if (pages.length)
          await createDocumentPages(
            tx,
            pages.map((page) => ({
              contentId: stored.id,
              pageNo: page.page,
              text: page.text,
            })),
          );
        return stored;
      });
    }
    await prisma.$transaction((tx) =>
      enqueueDocumentEmbedding(tx, {
        runId: job.runId,
        itemIndex: job.itemIndex,
        electoralTerm,
        referenceId,
        variantNo: content.variantNo,
      }),
    );
    await completeJob(prisma, job, workerId);
    return {
      status: "succeeded" as const,
      jobId: job.id,
      variantNo: content.variantNo,
      reused,
    };
  } catch (error) {
    const { exhausted } = await failJob(
      prisma,
      job,
      workerId,
      error instanceof Error ? error : new Error("Document processing failed"),
    );
    return {
      status: exhausted ? ("exhausted" as const) : ("retrying" as const),
      jobId: job.id,
    };
  }
}

// On-demand request: stored metadata and the original link return immediately,
// so a slow or failed download never delays the caller. Unprocessed work is
// queued at high priority; an identical request raises the existing job rather
// than adding a second one.
export async function requestDocument(
  prisma: PrismaClient,
  referenceId: string,
) {
  const reference = await findDocumentReferenceById(prisma, referenceId);
  if (!reference) return null;
  const content = await latestDocumentContent(prisma, referenceId);
  const key = documentJobKey({
    referenceId,
    pdfUrl: reference.pdfUrl,
    documentDate: reference.documentDate,
  });
  if (!content) {
    const queued = await prisma.processingJob.findUnique({
      where: { dedupeKey: key },
    });
    // Every stored citation came from a collection run. Without that encounter
    // there is no run to attach new work to; metadata still returns.
    const discovery = queued
      ? null
      : await latestStepDiscovery(prisma, reference.stepApiId);
    if (!queued && discovery) {
      await prisma.$transaction((tx) =>
        enqueueDocumentProcessing(tx, {
          runId: discovery.runId,
          itemIndex: null,
          electoralTerm: null,
          stepApiId: reference.stepApiId,
          referenceId,
          pdfUrl: reference.pdfUrl,
          documentDate: reference.documentDate,
        }),
      );
    }
    await raiseDocumentJob(prisma, key);
  }
  const job = await prisma.processingJob.findUnique({
    where: { dedupeKey: key },
  });
  return {
    reference: {
      referenceId,
      stepApiId: reference.stepApiId,
      proceedingApiId: reference.proceedingApiId,
      documentNumber: reference.documentNumber,
      documentDate: reference.documentDate,
      pdfUrl: reference.pdfUrl,
    },
    processed: content !== null,
    variant: content
      ? {
          variantNo: content.variantNo,
          pageCount: content.pageCount,
          byteHash: content.byteHash,
          fetchedAt: content.fetchedAt,
          sourceUrl: content.sourceUrl,
        }
      : null,
    job: job
      ? { id: job.id, status: job.status, priority: job.priority }
      : null,
  };
}
