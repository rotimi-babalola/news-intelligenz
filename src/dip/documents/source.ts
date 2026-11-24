import type { PrismaClient } from "../../generated/prisma/client";
import { findDocumentPage, listDocumentSections } from "../db/index";
import { loadDocumentCitation, STALE_REVISION_REASON } from "./citation";
import { toSection } from "./sections";

export const MISSING_PDF_REASON = "The PDF has not been processed.";

export function sourceDocumentUrl(
  referenceId: string,
  { page, stepId }: { page?: number; stepId?: string } = {},
) {
  const params = new URLSearchParams();
  if (page !== undefined) params.set("page", String(page));
  if (stepId !== undefined) params.set("step", stepId);
  const query = params.toString();
  return `/source/document/${referenceId}${query ? `?${query}` : ""}`;
}

export function pdfPageUrl(pdfUrl: string, page: number) {
  return `${pdfUrl.split("#")[0]}#page=${page}`;
}

// Stored PDF links are external data; only an HTTPS link may become a reader
// facing href.
export function isSafePdfUrl(pdfUrl: string | null): pdfUrl is string {
  if (!pdfUrl) return false;
  try {
    return new URL(pdfUrl).protocol === "https:";
  } catch {
    return false;
  }
}

// The section outline a step view can link to. Only the current variant's
// outline is offered, mirroring the stored text rules.
export async function getSourceDocumentOutline(
  prisma: PrismaClient,
  referenceId: string,
  stepApiId?: string,
) {
  if (
    !/^\d+$/.test(referenceId) ||
    (stepApiId !== undefined && !/^\d+$/.test(stepApiId))
  )
    return [];
  const citation = await loadDocumentCitation(prisma, referenceId, stepApiId);
  if (citation.status !== "current") return [];
  const sections = await listDocumentSections(prisma, citation.variant.id);
  return sections.flatMap((row) => {
    const section = toSection(row);
    return section ? [section] : [];
  });
}

// One reader-facing page view: stored text only while the reference and the
// latest variant still match, with a reason whenever no text may be shown.
export async function getSourceDocumentPage(
  prisma: PrismaClient,
  referenceId: string,
  page: number,
  stepApiId?: string,
) {
  if (
    !/^\d+$/.test(referenceId) ||
    (stepApiId !== undefined && !/^\d+$/.test(stepApiId)) ||
    !Number.isInteger(page) ||
    page < 1
  )
    return { status: "unknown" as const };
  const citation = await loadDocumentCitation(prisma, referenceId, stepApiId);
  if (citation.status === "unknown") return { status: "unknown" as const };
  const reference = citation.reference;
  const source = {
    referenceId,
    stepApiId: reference.stepApiId,
    proceedingApiId: reference.proceedingApiId,
    documentNumber: reference.documentNumber,
    documentDate: reference.documentDate?.toISOString() ?? null,
    pdfUrl: reference.pdfUrl,
  };
  const notProcessed = (reason: string) => ({
    status: "not-processed" as const,
    source,
    reason,
  });
  if (citation.status === "metadata-only")
    return {
      status: "metadata-only" as const,
      source,
      reason: citation.eligibility.reason,
    };
  if (citation.status === "stale") return notProcessed(STALE_REVISION_REASON);
  if (citation.status === "missing") return notProcessed(MISSING_PDF_REASON);

  const variant = citation.variant;
  // A page outside the stored range is answered from the document, never sent
  // to the database as an out-of-range integer.
  if (page > variant.pageCount)
    return {
      status: "page-missing" as const,
      source,
      page,
      pageCount: variant.pageCount,
    };
  const [pageRow, sections] = await Promise.all([
    findDocumentPage(prisma, variant.id, page),
    listDocumentSections(prisma, variant.id),
  ]);
  if (!pageRow)
    return {
      status: "page-missing" as const,
      source,
      page,
      pageCount: variant.pageCount,
    };
  const section =
    sections
      .map((row) => toSection(row))
      .find((item) => item && item.startPage <= page && page <= item.endPage) ??
    null;
  return {
    status: "available" as const,
    source,
    page,
    text: pageRow.text,
    section,
    pageCount: variant.pageCount,
  };
}
