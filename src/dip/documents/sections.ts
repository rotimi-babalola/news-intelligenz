import type { Client } from "../db/index";
import {
  createDocumentSections,
  listDocumentPages,
  listDocumentSections,
} from "../db/index";
import { isContentsPage, readHeading } from "./headings";

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

// Section headings are ordered by their first appearance. Repeated heading
// text is a running header; a reused label with a new title starts a section.
export function detectDocumentSections(
  pages: DocumentSectionInput[],
): DetectedDocumentSection[] {
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  if (ordered.length === 0) return [];
  const headings: { page: number; label: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const page of ordered) {
    if (isContentsPage(page.text)) continue;
    for (const line of page.text.split(/\r?\n/)) {
      const heading = readHeading(line);
      if (!heading) continue;
      const key = `${heading.label}\0${heading.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
