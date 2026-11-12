import type { PrismaClient } from "../generated/prisma/client";
import { classifyDocumentReference } from "./excerpts";
import {
  findDocumentReferenceById,
  latestDocumentContent,
  listBoundedDocumentPages,
  listDocumentSections,
} from "./repository";
import { toSection } from "./sections";

const MAX_PAGE_TEXT = 2000;

export async function getDocumentPages(
  prisma: PrismaClient,
  referenceId: string,
  startPage: number,
  limit: number,
) {
  const reference = await findDocumentReferenceById(prisma, referenceId);
  if (!reference) return { status: "unknown", referenceId };

  const eligibility = classifyDocumentReference({
    institution: reference.step.institution,
    documentType: reference.step.documentType,
    documentNumber: reference.documentNumber,
    pdfUrl: reference.pdfUrl,
    metadata: reference.metadata,
  });
  const source = {
    referenceId,
    stepApiId: reference.stepApiId,
    proceedingApiId: reference.proceedingApiId,
    documentNumber: reference.documentNumber,
    pdfUrl: reference.pdfUrl,
  };
  if (eligibility.status === "metadata-only")
    return { status: "metadata-only", source, eligibility };

  const variant = await latestDocumentContent(prisma, referenceId);
  if (!variant)
    return { status: "unavailable", source, eligibility, variant: null };
  if (variant.requestedUrl !== reference.pdfUrl)
    return {
      status: "metadata-only",
      source,
      eligibility: {
        status: "metadata-only" as const,
        reason: "Document revision has not been processed",
      },
    };
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
      eligibility,
      variant: storedVariant,
      sections: outline,
    };
  return {
    status: "available",
    source,
    eligibility,
    variant: storedVariant,
    pages: pages.map(({ pageNo, text }) => ({
      page: pageNo,
      text: text.slice(0, MAX_PAGE_TEXT),
      truncated: text.length > MAX_PAGE_TEXT,
    })),
    sections: outline,
    changes: "Text extracted from PDF and excerpted",
  };
}
