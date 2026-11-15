import type { DetectedDocumentSection } from "./sections";
import { headingText, isContentsPage, normalizeHeadingText } from "./headings";

type PdfLine = { page: number; text: string; y: number };
type PdfPage = {
  page: number;
  height: number;
  lines: { text: string; y: number }[];
};
export type PdfEvidence = {
  pageCount: number;
  pages: PdfPage[];
  occurrences: PdfLine[];
  intervening: PdfLine[];
};

type Anchor = { page: number; text: string; y: number } | null;
type Boundary = Anchor | { page: number; text: string };

// A heading anchors the section only as a unique body line: not a contents
// entry, not a running header, not in the top margin, and followed by text
// rather than a table of contents entry.
function anchorHeading(
  page: PdfPage | undefined,
  heading: string,
  evidence: PdfEvidence,
): Anchor {
  // shortcut: a lone leaderless contents entry can mimic a body heading; use richer layout evidence if those PDFs appear.
  if (!page) return null;
  const matches = page.lines.filter(
    (line) => normalizeHeadingText(line.text) === heading,
  );
  if (matches.length !== 1) return null;
  if (page.lines.some((line) => isContentsPage(line.text))) return null;
  if (matches[0]!.y < page.height * 0.08) return null;
  if (
    evidence.occurrences.filter(
      (line) => normalizeHeadingText(line.text) === heading,
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

function headingLines(
  page: PdfPage | undefined,
  heading: string,
): PdfPage["lines"] | undefined {
  return page?.lines
    .filter((line) => normalizeHeadingText(line.text) === heading)
    .slice(0, 3);
}

// The stored outline and the archived PDF describe the same section in two
// ways; the verdict is the one place that compares them. Every failed check is
// a reason, so a caller can say why a section stayed ambiguous.
export function decideSectionEvidence({
  section,
  outline,
  pageText,
  variantPageCount,
  layout,
}: {
  section: DetectedDocumentSection;
  outline: DetectedDocumentSection[];
  pageText: string;
  variantPageCount: number;
  layout: PdfEvidence;
}) {
  const next = outline.find((row) => row.sectionNo === section.sectionNo + 1);
  const pdfPage = (number: number) =>
    layout.pages.find((entry) => entry.page === number);
  const heading = headingText(section);
  const start = anchorHeading(pdfPage(section.startPage), heading, layout);
  const boundary: Boundary = next
    ? anchorHeading(pdfPage(next.startPage), headingText(next), layout)
    : { page: layout.pageCount, text: "Document end" };
  const sharedPage = outline.some(
    (row) =>
      row.sectionNo !== section.sectionNo &&
      row.startPage === section.startPage,
  );
  const validRange =
    layout.pageCount === variantPageCount &&
    section.startPage >= 1 &&
    section.endPage <= layout.pageCount &&
    section.endPage === (next ? next.startPage - 1 : layout.pageCount);
  const offset = pageText.indexOf(heading);
  const surroundingText =
    offset < 0
      ? null
      : pageText.slice(
          Math.max(0, offset - 300),
          offset + heading.length + 300,
        );
  const reasons = [
    ...(start
      ? []
      : ["Start heading is not a unique body line on the stored start page"]),
    ...(boundary ? [] : ["Next heading is not anchored on its boundary page"]),
    ...(sharedPage ? ["Another section starts on the same page"] : []),
    ...(validRange ? [] : ["Stored page range does not match the PDF"]),
    ...(surroundingText
      ? []
      : ["Stored page text does not contain the heading"]),
    ...(layout.intervening.length
      ? ["An unlisted heading appears inside the stored range"]
      : []),
  ];
  return {
    status: reasons.length ? ("ambiguous" as const) : ("verified" as const),
    reasons,
    headingAnchor: start,
    boundary,
    surroundingText,
    headingLines: headingLines(pdfPage(section.startPage), heading),
    nextHeadingLines: next
      ? headingLines(pdfPage(next.startPage), headingText(next))
      : null,
  };
}
