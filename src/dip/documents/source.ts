import type { PrismaClient } from "../../generated/prisma/client";
import { findDocumentPage, listDocumentSections } from "../db/index";
import { loadDocumentCitation, STALE_REVISION_REASON } from "./citation";
import { toSection } from "./sections";

export const MISSING_PDF_REASON = "The PDF has not been processed.";

export function sourceDocumentUrl(referenceId: string, page?: number) {
  return page === undefined
    ? `/source/document/${referenceId}`
    : `/source/document/${referenceId}?page=${page}`;
}

export function pdfPageUrl(pdfUrl: string, page: number) {
  return `${pdfUrl.split("#")[0]}#page=${page}`;
}

// One reader-facing page view: stored text only while the reference and the
// latest variant still match, with a reason whenever no text may be shown.
export async function getSourceDocumentPage(
  prisma: PrismaClient,
  referenceId: string,
  page: number,
) {
  if (!/^\d+$/.test(referenceId) || !Number.isInteger(page) || page < 1)
    return { status: "unknown" as const };
  const citation = await loadDocumentCitation(prisma, referenceId);
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
    return notProcessed(citation.eligibility.reason);
  if (citation.status === "stale") return notProcessed(STALE_REVISION_REASON);
  if (citation.status === "missing") return notProcessed(MISSING_PDF_REASON);

  const variant = citation.variant;
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
