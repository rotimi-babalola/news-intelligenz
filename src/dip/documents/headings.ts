import { MAX_SECTION_HEADING_LENGTH } from "../constants";

type DocumentHeading = { label: string; title: string };

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

export function readHeading(line: string): DocumentHeading | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_SECTION_HEADING_LENGTH) return null;
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

export function isContentsPage(text: string) {
  return CONTENTS_PAGE.test(text);
}

// Stored page text and PDF layout lines differ in whitespace, so both sides of
// a heading comparison go through the same form.
export function headingText(heading: DocumentHeading) {
  return `${heading.label} ${heading.title}`;
}

export function normalizeHeadingText(text: string) {
  return text.replace(/\s+/g, " ");
}
