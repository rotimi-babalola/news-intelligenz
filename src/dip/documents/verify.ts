import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { PrismaClient } from "../../generated/prisma/client";
import { loadDocumentCitation, STALE_REVISION_REASON } from "./citation";
import { getDocumentPdf } from "./object-store";
import { findDocumentPage, listDocumentSections } from "../db/index";

type PdfPage = {
  page: number;
  height: number;
  lines: { text: string; y: number }[];
};
type PdfLine = { page: number; text: string; y: number };
type PdfEvidence = {
  pageCount: number;
  pages: PdfPage[];
  occurrences: PdfLine[];
  intervening: PdfLine[];
};

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

function anchor(
  page: PdfPage | undefined,
  heading: string,
  evidence: PdfEvidence,
) {
  // shortcut: a lone leaderless contents entry can mimic a body heading; use richer layout evidence if those PDFs appear.
  if (!page) return null;
  const matches = page.lines.filter(
    (line) => line.text.replace(/\s+/g, " ") === heading,
  );
  if (matches.length !== 1) return null;
  if (
    page.lines.some((line) =>
      /^(Inhaltsverzeichnis|Inhaltsübersicht|Inhalt|Gliederung|Contents)$/.test(
        line.text,
      ),
    )
  )
    return null;
  if (matches[0]!.y < page.height * 0.08) return null;
  if (
    evidence.occurrences.filter(
      (line) => line.text.replace(/\s+/g, " ") === heading,
    ).length !== 1
  )
    return null;
  const after = page.lines.slice(page.lines.indexOf(matches[0]!) + 1);
  if (
    !after.some(
      (line) =>
        line.text.length > 10 &&
        !/^\d+$/.test(line.text) &&
        !/\.{3,}|…/.test(line.text),
    )
  )
    return null;
  return {
    page: page.page,
    text: matches[0]!.text,
    y: Math.round(matches[0]!.y),
  };
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
      headings: [
        `${section.label} ${section.title}`,
        ...(next ? [`${next.label} ${next.title}`] : []),
      ],
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
  const pdfPage = (number: number) =>
    evidence.pages.find((entry) => entry.page === number);
  const heading = `${section.label} ${section.title}`;
  const start = anchor(pdfPage(section.startPage), heading, evidence);
  const boundary = next
    ? anchor(pdfPage(next.startPage), `${next.label} ${next.title}`, evidence)
    : { page: evidence.pageCount, text: "Document end" };
  const sharedPage =
    sections.some(
      (row) =>
        row.sectionNo !== sectionNo && row.startPage === section.startPage,
    ) ||
    (next !== undefined && next.startPage === section.startPage);
  const validRange =
    evidence.pageCount === variant.pageCount &&
    section.startPage >= 1 &&
    section.endPage <= evidence.pageCount &&
    section.endPage === (next ? next.startPage - 1 : evidence.pageCount);
  const offset = page.text.indexOf(heading);
  const context =
    offset < 0
      ? null
      : page.text.slice(
          Math.max(0, offset - 300),
          offset + heading.length + 300,
        );
  return {
    status:
      start &&
      boundary &&
      !sharedPage &&
      validRange &&
      context &&
      evidence.intervening.length === 0
        ? "verified"
        : "ambiguous",
    source,
    variant: identity,
    section: {
      sectionNo,
      label: section.label,
      title: section.title,
      startPage: section.startPage,
      endPage: section.endPage,
    },
    headingAnchor: start,
    surroundingText: context,
    boundary,
    evidence: {
      pdfPageCount: evidence.pageCount,
      heading: pdfPage(section.startPage)
        ?.lines.filter((line) => line.text.replace(/\s+/g, " ") === heading)
        .slice(0, 3),
      nextHeading: next
        ? pdfPage(next.startPage)
            ?.lines.filter(
              (line) =>
                line.text.replace(/\s+/g, " ") ===
                `${next.label} ${next.title}`,
            )
            .slice(0, 3)
        : null,
      interveningHeadings: evidence.intervening,
    },
  };
}
