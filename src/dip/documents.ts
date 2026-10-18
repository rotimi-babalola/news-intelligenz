import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { claimNextJob, completeJob, failJob } from "../jobs";
import { enqueueDocumentEmbedding, PROCESS_DOCUMENT } from "./jobs";
import { fetchDocumentPdf, pymupdfExtractor, type PageExtractor } from "./pdf";
import {
  createDocumentContent,
  createDocumentPages,
  findDocumentContentByHash,
  latestDocumentContent,
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
    if (typeof payload.electoralTerm !== "number")
      throw new Error("Document job is missing its electoral term");
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
        electoralTerm: payload.electoralTerm as number,
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
