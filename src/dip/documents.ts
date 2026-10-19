import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { claimNextJob, completeJob, failJob } from "../jobs";
import {
  documentJobKey,
  enqueueDocumentEmbedding,
  enqueueDocumentProcessing,
  PROCESS_DOCUMENT,
  raiseDocumentJob,
} from "./jobs";
import {
  fetchDocumentPdf,
  pymupdfExtractor,
  type ExtractedPage,
  type PageExtractor,
} from "./pdf";
import {
  createDocumentContent,
  createDocumentPages,
  findDocumentContentByHash,
  findDocumentReferenceById,
  latestDocumentContent,
  latestStepDiscovery,
  listDocumentPages,
  maxDocumentVariantNo,
  supersedeDocumentContents,
} from "./repository";

// PDF processing is downstream of DIP collection and never part of it: the
// document job fetches bytes, caches a content variant, extracts page text and
// hands embedding to durable per-page jobs. A failure here leaves the source
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

// Concurrent revisions of one document must not pick the same variant number
// or leave two rows marked latest. The lock is per reference and short-lived.
function lockDocumentReference(
  tx: Prisma.TransactionClient,
  referenceId: string,
) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${referenceId}, 0))`;
}

async function storeNewVariant(
  tx: Prisma.TransactionClient,
  input: {
    referenceId: string;
    byteHash: string;
    bytes: Buffer;
    finalUrl: string;
    pages: ExtractedPage[];
  },
): Promise<{
  content: Awaited<ReturnType<typeof createDocumentContent>>;
  reused: boolean;
}> {
  // Another worker may have stored these exact bytes while we extracted.
  const existing = await findDocumentContentByHash(
    tx,
    input.referenceId,
    input.byteHash,
  );
  if (existing) {
    if (existing.isLatest) return { content: existing, reused: true };
    await supersedeDocumentContents(tx, input.referenceId);
    return {
      content: await tx.documentContent.update({
        where: { id: existing.id },
        data: { isLatest: true },
      }),
      reused: true,
    };
  }
  const variantNo = (await maxDocumentVariantNo(tx, input.referenceId)) + 1;
  await supersedeDocumentContents(tx, input.referenceId);
  const content = await createDocumentContent(tx, {
    referenceId: input.referenceId,
    variantNo,
    byteHash: input.byteHash,
    byteSize: input.bytes.byteLength,
    pageCount: input.pages.length,
    bytes: new Uint8Array(input.bytes),
    sourceUrl: input.finalUrl,
  });
  if (input.pages.length)
    await createDocumentPages(
      tx,
      input.pages.map((page) => ({
        contentId: content.id,
        pageNo: page.page,
        text: page.text,
      })),
    );
  return { content, reused: false };
}

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
    // Reverting to earlier bytes promotes that retained variant back to
    // latest; only the latest variant is searchable.
    let content = await findDocumentContentByHash(
      prisma,
      referenceId,
      byteHash,
    );
    let reused = content !== null;
    if (!content) {
      const pages = await (options.extract ?? pymupdfExtractor)(fetched.bytes);
      content = await prisma.$transaction(async (tx) => {
        await lockDocumentReference(tx, referenceId);
        const stored = await storeNewVariant(tx, {
          referenceId,
          byteHash,
          bytes: fetched.bytes,
          finalUrl: fetched.finalUrl,
          pages,
        });
        reused = stored.reused;
        return stored.content;
      });
    } else if (!content.isLatest) {
      const cached = content;
      content = await prisma.$transaction(async (tx) => {
        await lockDocumentReference(tx, referenceId);
        await supersedeDocumentContents(tx, referenceId);
        return tx.documentContent.update({
          where: { id: cached.id },
          data: { isLatest: true },
        });
      });
    }
    const pageRows = await listDocumentPages(prisma, content.id);
    await prisma.$transaction(async (tx) => {
      for (const page of pageRows) {
        if (!page.text.trim()) continue;
        await enqueueDocumentEmbedding(tx, {
          runId: job.runId,
          itemIndex: job.itemIndex,
          electoralTerm,
          referenceId,
          variantNo: content.variantNo,
          pageNo: page.pageNo,
          priority: job.priority,
        });
      }
    });
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
  let job = await prisma.processingJob.findUnique({
    where: { dedupeKey: key },
  });
  // A changed reference (new url or date) is a new revision with no job yet,
  // even when an earlier variant of the same document is already cached.
  const processed = content !== null && job?.status === "succeeded";
  if (!processed) {
    // Every stored citation came from a collection run. Without that encounter
    // there is no run to attach new work to; metadata still returns.
    const discovery = job
      ? null
      : await latestStepDiscovery(prisma, reference.stepApiId);
    if (!job && discovery) {
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
    job = (await raiseDocumentJob(prisma, key)) ?? job;
  }
  return {
    reference: {
      referenceId,
      stepApiId: reference.stepApiId,
      proceedingApiId: reference.proceedingApiId,
      documentNumber: reference.documentNumber,
      documentDate: reference.documentDate,
      pdfUrl: reference.pdfUrl,
    },
    processed,
    variant: processed
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
