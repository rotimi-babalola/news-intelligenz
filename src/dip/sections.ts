import type { Client } from "./repository";
import {
  createDocumentSections,
  listDocumentPages,
  listDocumentSections,
} from "./repository";

export type DocumentSectionInput = { pageNo: number; text: string };

// One outline shape shared by detection, stored rows, and the MCP/search output.
export type DocumentSectionView = {
  label: string;
  title: string;
  startPage: number;
  endPage: number;
};

export type DetectedDocumentSection = DocumentSectionView & {
  sectionNo: number;
};

// Stored rows and search rows carry the same fields, nullable when no section
// covers the page; one projection keeps the published shape from drifting.
export function toSection(section: {
  label: string | null;
  title: string | null;
  startPage: number | null;
  endPage: number | null;
}): DocumentSectionView | null {
  if (
    section.label === null ||
    section.title === null ||
    section.startPage === null ||
    section.endPage === null
  )
    return null;
  return {
    label: section.label,
    title: section.title,
    startPage: section.startPage,
    endPage: section.endPage,
  };
}

type Heading = { label: string; title: string };

// Drucksachen mark structural items with explicit labels: `A.4`, `B.21`,
// top-level `A.`/`B.`, or Roman numerals. A heading must start its own line,
// carry a title, and not end like a sentence.
const HEADING_PATTERNS: {
  pattern: RegExp;
  label: (match: RegExpExecArray) => string;
}[] = [
  {
    pattern: /^([A-Z])\.(\d+)[.)]?\s+(\S.*)$/,
    label: (match) => `${match[1]}.${match[2]}`,
  },
  {
    pattern: /^([A-Z])\.\s+(\S.*)$/,
    label: (match) => `${match[1]}.`,
  },
  {
    pattern: /^([IVXLC]+)\.\s+(\S.*)$/,
    label: (match) => `${match[1]}.`,
  },
];

// shortcut: labels are matched without layout context, so a body enumeration
// that does not end like a sentence (`A. Die Bundesregierung wird aufgefordert`)
// can still read as a heading; use a layout-aware extractor if outlines must be
// exact.

// A contents page lists the same labels as the body. Skipping the whole page
// avoids mistaking a leaderless contents entry for the section start.
const CONTENTS_PAGE =
  /^(?:Inhaltsverzeichnis|Inhaltsübersicht|Inhalt|Gliederung|Contents)\s*$/im;

function readHeading(line: string): Heading | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 200) return null;
  for (const { pattern, label } of HEADING_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const title = (match[3] ?? match[2] ?? "").trim();
    if (!title) return null;
    if (!/^[\p{Lu}\d]/u.test(title)) return null;
    // Table of contents entries end in leader dots or a trailing page number;
    // body prose ends like a sentence.
    if (
      /\.{3,}|…/.test(title) ||
      /\s\d{1,4}$/.test(title) ||
      /[.!?]$/.test(title)
    )
      return null;
    return { label: label(match), title };
  }
  return null;
}

// Section headings are ordered by their first appearance. A repeated label is
// a running header, so only its first occurrence starts a section.
export function detectDocumentSections(
  pages: DocumentSectionInput[],
): DetectedDocumentSection[] {
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  if (ordered.length === 0) return [];
  const headings: { page: number; label: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const page of ordered) {
    if (CONTENTS_PAGE.test(page.text)) continue;
    for (const line of page.text.split(/\r?\n/)) {
      const heading = readHeading(line);
      if (!heading || seen.has(heading.label)) continue;
      seen.add(heading.label);
      headings.push({ page: page.pageNo, ...heading });
    }
  }
  const lastPage = ordered.at(-1)!.pageNo;
  return headings.map((heading, index) => {
    const next = headings[index + 1];
    return {
      sectionNo: index + 1,
      label: heading.label,
      title: heading.title,
      startPage: heading.page,
      endPage: next
        ? next.page > heading.page
          ? next.page - 1
          : next.page
        : lastPage,
    };
  });
}

// An existing outline belongs to this content variant; changed bytes create a
// new variant and therefore a new outline. Empty detection leaves no rows, so
// a document without headings stays explicitly outlineless instead of receiving
// an invented one.
export async function ensureDocumentSections(
  client: Client,
  contentId: string,
  pages: DocumentSectionInput[],
) {
  const existing = await listDocumentSections(client, contentId);
  if (existing.length) return existing;
  const detected = detectDocumentSections(pages);
  if (!detected.length) return [];
  await createDocumentSections(
    client,
    detected.map((section) => ({ contentId, ...section })),
  );
  return listDocumentSections(client, contentId);
}

// Variants processed before outlines existed have pages but no derived rows.
// Only latest variants are outlined, mirroring retrieval, and re-running is
// safe because ensureDocumentSections leaves an existing outline untouched.
export async function backfillDocumentSections(client: Client) {
  const contents = await client.documentContent.findMany({
    where: { isLatest: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let outlines = 0;
  for (const { id } of contents) {
    const pages = await listDocumentPages(client, id);
    if ((await ensureDocumentSections(client, id, pages)).length) outlines++;
  }
  return { variants: contents.length, outlines };
}
