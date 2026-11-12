import type { Client } from "./repository";
import { createDocumentSections, listDocumentSections } from "./repository";

export type DocumentSectionInput = { pageNo: number; text: string };

export type DetectedDocumentSection = {
  sectionNo: number;
  label: string;
  title: string;
  startPage: number;
  endPage: number;
};

type Heading = { label: string; title: string };

// Drucksachen mark structural items with explicit labels: `A.4`, `B.21`,
// top-level `A.`/`B.`, or Roman numerals. A heading must start its own line and
// carry a title; a bare label, a table-of-contents entry, or a prose line is
// left out rather than guessed at.
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
    if (!title || title.length > 200) return null;
    if (!/^[\p{Lu}\d]/u.test(title)) return null;
    // Table of contents entries end in leader dots or a trailing page number.
    if (/\.{3,}|…/.test(title) || /\s\d{1,4}$/.test(title)) return null;
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
