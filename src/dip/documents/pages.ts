import type { PrismaClient } from "../../generated/prisma/client";
import { MAX_DOCUMENT_PAGE_TEXT } from "../constants";
import { listBoundedDocumentPages, listDocumentSections } from "../db/index";
import { loadDocumentCitation, STALE_REVISION_REASON } from "./citation";
import { toSection } from "./sections";

export async function getDocumentPages(
  prisma: PrismaClient,
  referenceId: string,
  startPage: number,
  limit: number,
) {
  const citation = await loadDocumentCitation(prisma, referenceId);
  if (citation.status === "unknown") return { status: "unknown", referenceId };

  const reference = citation.reference;
  const source = {
    referenceId,
    stepApiId: reference.stepApiId,
    proceedingApiId: reference.proceedingApiId,
    documentNumber: reference.documentNumber,
    pdfUrl: reference.pdfUrl,
  };
  if (citation.status === "metadata-only")
    return {
      status: "metadata-only",
      source,
      eligibility: citation.eligibility,
    };
  if (citation.status === "stale")
    return {
      status: "metadata-only",
      source,
      eligibility: {
        status: "metadata-only" as const,
        reason: STALE_REVISION_REASON,
      },
    };
  if (citation.status === "missing")
    return {
      status: "unavailable",
      source,
      eligibility: citation.eligibility,
      variant: null,
    };

  const variant = citation.variant;
  const [pages, sections] = await Promise.all([
    listBoundedDocumentPages(prisma, variant.id, startPage, limit),
    listDocumentSections(prisma, variant.id),
  ]);
  // The outline belongs to the stored variant, so it is returned together with
  // the variant's pages and omitted when the revision no longer matches.
  const outline = sections.flatMap((section) => toSection(section) ?? []);
  const storedVariant = {
    variantNo: variant.variantNo,
    sourceUrl: variant.sourceUrl,
  };
  if (!pages.length)
    return {
      status: "unavailable",
      source,
      eligibility: citation.eligibility,
      variant: storedVariant,
      sections: outline,
    };
  return {
    status: "available",
    source,
    eligibility: citation.eligibility,
    variant: storedVariant,
    pages: pages.map(({ pageNo, text }) => ({
      page: pageNo,
      text: text.slice(0, MAX_DOCUMENT_PAGE_TEXT),
      truncated: text.length > MAX_DOCUMENT_PAGE_TEXT,
    })),
    sections: outline,
    changes: "Text extracted from PDF and excerpted",
  };
}
