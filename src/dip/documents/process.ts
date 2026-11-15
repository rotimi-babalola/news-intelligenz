import { createHash } from "node:crypto";
import { ensureDocumentChunks } from "./chunks";
import { resolveDocumentCitation } from "./citation";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { runNextJob, type ClaimedJob } from "../../jobs/index";
import { PROCESS_DOCUMENT } from "../constants";
import {
  enqueueDocumentEmbeddings,
  enqueueDocumentProcessing,
  raiseDocumentJob,
} from "../jobs/queue";
import { documentJobKey, documentProcessingPayload } from "../jobs/identity";
import { documentObjectKey, putDocumentPdf } from "./object-store";
import {
  fetchDocumentPdf,
  pymupdfExtractor,
  type ExtractedPage,
  type PageExtractor,
} from "./pdf";
import { ensureDocumentSections } from "./sections";
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
} from "../db/index";

// PDF processing is downstream of DIP collection and never part of it: the
// document job fetches bytes, caches a content variant, extracts page text and
// hands embedding to durable per-passage jobs. A failure here leaves the source
// reference, its metadata and its original link intact and never holds an
// endpoint checkpoint open.
//
// shortcut: permanent-looking failures (missing url, 404, unreadable PDF) use
// the full bounded retry budget. Split a permanent-failure path once document
// volume makes repeated fetches costly.

export type ProcessDocumentOptions = {
  fetchPdf?: typeof fetchDocumentPdf;
  extract?: PageExtractor;
  putPdf?: typeof putDocumentPdf;
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
    objectKey: string;
    byteSize: number;
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
    byteSize: input.byteSize,
    pageCount: input.pages.length,
    objectKey: input.objectKey,
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
  return runNextJob(
    prisma,
    workerId,
    { operation: PROCESS_DOCUMENT, jobId: options.jobId },
    (job) => processDocumentJob(prisma, job, options),
    { failureMessage: "Document processing failed" },
  );
}

async function processDocumentJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  options: ProcessDocumentOptions,
) {
  const payload = documentProcessingPayload.parse(job.payload);
  const electoralTerm = payload.electoralTerm ?? null;
  const referenceId = payload.referenceId;
  const pdfUrl = payload.pdfUrl;
  if (!pdfUrl) throw new Error("Document reference has no pdf_url");

  const fetched = await (options.fetchPdf ?? fetchDocumentPdf)(pdfUrl);
  if (!fetched.ok) throw new Error(`Document fetch failed: ${fetched.reason}`);
  const byteHash = createHash("sha256").update(fetched.bytes).digest("hex");

  // Identical bytes are the same content variant: reuse the cached row and
  // skip extraction entirely. Changed bytes become a new retained variant.
  // Reverting to earlier bytes promotes that retained variant back to
  // latest; only the latest variant is searchable.
  let content = await findDocumentContentByHash(prisma, referenceId, byteHash);
  let reused = content !== null;
  if (!content) {
    const pages = await (options.extract ?? pymupdfExtractor)(fetched.bytes);
    const objectKey = documentObjectKey(referenceId, byteHash);
    // Upload before the transaction: a failed upload retries the job, and a
    // failed transaction leaves an unreferenced object that the same
    // content-addressed key overwrites on retry.
    await (options.putPdf ?? putDocumentPdf)(objectKey, fetched.bytes);
    content = await prisma.$transaction(async (tx) => {
      await lockDocumentReference(tx, referenceId);
      const stored = await storeNewVariant(tx, {
        referenceId,
        byteHash,
        objectKey,
        byteSize: fetched.bytes.byteLength,
        finalUrl: fetched.finalUrl,
        pages,
      });
      reused = stored.reused;
      return stored.content;
    });
  } else {
    const cached = content;
    // Rows written before the object-storage move, or left by an upload that
    // committed no key, still need their bytes archived. The fetched bytes
    // are the same content-addressed variant, so upload with the same key.
    if (!cached.objectKey) {
      const objectKey = documentObjectKey(referenceId, byteHash);
      await (options.putPdf ?? putDocumentPdf)(objectKey, fetched.bytes);
      content = await prisma.documentContent.update({
        where: { id: cached.id },
        // The fetched bytes now live in object storage, so a legacy row no
        // longer needs its database copy.
        data: { objectKey, bytes: null },
      });
    }
    if (!cached.isLatest) {
      content = await prisma.$transaction(async (tx) => {
        await lockDocumentReference(tx, referenceId);
        await supersedeDocumentContents(tx, referenceId);
        return tx.documentContent.update({
          where: { id: cached.id },
          data: { isLatest: true },
        });
      });
    }
  }
  const pageRows = await listDocumentPages(prisma, content.id);
  const chunks = await ensureDocumentChunks(prisma, content.id, pageRows);
  await ensureDocumentSections(prisma, content.id, pageRows);
  await prisma.documentContent.update({
    where: { id: content.id },
    data: { requestedUrl: pdfUrl },
  });
  await enqueueDocumentEmbeddings(prisma, {
    runId: job.runId,
    itemIndex: job.itemIndex,
    electoralTerm,
    referenceId,
    variantNo: content.variantNo,
    chunks,
    priority: job.priority,
  });
  return { variantNo: content.variantNo, reused };
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
  const citation = resolveDocumentCitation(
    reference,
    await latestDocumentContent(prisma, referenceId),
  );
  const content = citation.status === "missing" ? null : citation.variant;
  const referenceIdentity = {
    referenceId,
    pdfUrl: reference.pdfUrl,
    documentDate: reference.documentDate,
  };
  const key = documentJobKey(referenceIdentity);
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
          ...referenceIdentity,
        }),
      );
    }
    job = (await raiseDocumentJob(prisma, referenceIdentity)) ?? job;
  }
  return {
    eligibility: citation.eligibility,
    reference: {
      referenceId,
      stepApiId: reference.stepApiId,
      proceedingApiId: reference.proceedingApiId,
      documentNumber: reference.documentNumber,
      documentDate: reference.documentDate,
      pdfUrl: reference.pdfUrl,
    },
    processed,
    variant:
      processed && content
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
