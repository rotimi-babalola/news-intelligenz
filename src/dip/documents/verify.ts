import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { PrismaClient } from "../../generated/prisma/client";
import { loadDocumentCitation, STALE_REVISION_REASON } from "./citation";
import { getDocumentPdf } from "./object-store";
import { findDocumentPage, listDocumentSections } from "../db/index";
import { headingText } from "./headings";
import { decideSectionEvidence, type PdfEvidence } from "./section-evidence";

export function inspectDocumentPdf(
  bytes: Buffer,
  request: {
    pages: number[];
    headings: string[];
    startPage: number;
    endPage: number;
  },
): Promise<PdfEvidence> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [
        join(process.cwd(), "scripts", "inspect_pdf.py"),
        JSON.stringify(request),
      ],
      { maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout) as PdfEvidence);
        } catch {
          reject(new Error("PDF inspection returned invalid JSON"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(bytes);
  });
}

export async function verifyDocumentSection(
  prisma: PrismaClient,
  referenceId: string,
  sectionNo: number,
  readPdf = getDocumentPdf,
  inspectPdf = inspectDocumentPdf,
) {
  const citation = await loadDocumentCitation(prisma, referenceId);
  if (citation.status === "unknown")
    return {
      status: "unavailable",
      referenceId,
      reason: "Document reference not found",
    };
  const reference = citation.reference;
  const source = {
    referenceId,
    pdfUrl: reference.pdfUrl,
    documentNumber: reference.documentNumber,
    ...(citation.eligibility.status === "excerpt-eligible"
      ? {
          attribution: citation.eligibility.source,
          document: citation.eligibility.document,
        }
      : {}),
  };
  if (citation.status === "metadata-only")
    return {
      status: "metadata-only",
      source,
      eligibility: citation.eligibility,
    };
  if (citation.status === "missing")
    return {
      status: "unavailable",
      source,
      reason: "No processed PDF variant",
    };
  if (citation.status === "stale")
    return {
      status: "unavailable",
      source,
      reason: STALE_REVISION_REASON,
    };
  const variant = citation.variant;
  const identity = {
    variantNo: variant.variantNo,
    byteHash: variant.byteHash,
    sourceUrl: variant.sourceUrl,
  };
  const sections = await listDocumentSections(prisma, variant.id);
  const section = sections.find((row) => row.sectionNo === sectionNo);
  if (!section)
    return {
      status: "unavailable",
      source,
      variant: identity,
      reason: "Section not found",
    };
  const next = sections.find((row) => row.sectionNo === sectionNo + 1);
  const page = await findDocumentPage(prisma, variant.id, section.startPage);
  if (!page)
    return {
      status: "unavailable",
      source,
      variant: identity,
      reason: "Stored page not found",
    };
  if (!variant.objectKey && !variant.bytes)
    return {
      status: "unavailable",
      source,
      variant: identity,
      reason: "Archived PDF unavailable",
    };

  let evidence: PdfEvidence;
  try {
    const bytes = variant.objectKey
      ? await readPdf(variant.objectKey)
      : Buffer.from(variant.bytes!);
    if (createHash("sha256").update(bytes).digest("hex") !== variant.byteHash)
      return {
        status: "unavailable",
        source,
        variant: identity,
        reason: "Archived PDF hash mismatch",
      };
    evidence = await inspectPdf(bytes, {
      pages: [section.startPage, next?.startPage ?? 0],
      headings: [headingText(section), ...(next ? [headingText(next)] : [])],
      startPage: section.startPage,
      endPage: section.endPage,
    });
  } catch {
    return {
      status: "unavailable",
      source,
      variant: identity,
      reason: "PDF inspection unavailable",
    };
  }
  const decision = decideSectionEvidence({
    section,
    outline: sections,
    pageText: page.text,
    variantPageCount: variant.pageCount,
    layout: evidence,
  });
  return {
    status: decision.status,
    source,
    variant: identity,
    section: {
      sectionNo,
      label: section.label,
      title: section.title,
      startPage: section.startPage,
      endPage: section.endPage,
    },
    headingAnchor: decision.headingAnchor,
    surroundingText: decision.surroundingText,
    boundary: decision.boundary,
    evidence: {
      pdfPageCount: evidence.pageCount,
      heading: decision.headingLines,
      nextHeading: decision.nextHeadingLines,
      interveningHeadings: evidence.intervening,
    },
  };
}
