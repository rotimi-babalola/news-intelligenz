import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideSectionEvidence,
  type PdfEvidence,
} from "../src/dip/documents/section-evidence.js";

const a4 = {
  sectionNo: 1,
  label: "A.4",
  title: "Steuerliche Behandlung",
  startPage: 2,
  endPage: 2,
};
const b21 = {
  sectionNo: 2,
  label: "B.21",
  title: "Förderung",
  startPage: 3,
  endPage: 3,
};
const heading = "A.4 Steuerliche Behandlung";
const nextHeading = "B.21 Förderung";
const pageText = `${"Preface ".repeat(300)}${heading}\nA passage to cite`;

type Options = {
  contents?: boolean;
  running?: boolean;
  duplicate?: boolean;
  shared?: boolean;
  intervening?: boolean;
  margin?: boolean;
  pageText?: string;
  variantPageCount?: number;
  section?: typeof a4;
  outline?: (typeof a4)[];
};

function layout(options: Options): PdfEvidence {
  return {
    pageCount: 3,
    occurrences: [
      { page: 2, text: heading, y: options.margin ? 30 : 140 },
      { page: 3, text: nextHeading, y: 160 },
      ...(options.running ? [{ page: 1, text: heading, y: 30 }] : []),
      ...(options.duplicate ? [{ page: 3, text: heading, y: 600 }] : []),
    ],
    intervening: options.intervening
      ? [{ page: 2, text: "C.1 Omitted heading", y: 450 }]
      : [],
    pages: [
      {
        page: 2,
        height: 800,
        lines: [
          ...(options.contents ? [{ text: "Inhaltsverzeichnis", y: 60 }] : []),
          { text: heading, y: options.margin ? 30 : 140 },
          { text: "A passage to cite in the body", y: 180 },
          ...(options.shared ? [{ text: nextHeading, y: 400 }] : []),
        ],
      },
      {
        page: 3,
        height: 800,
        lines: [
          ...(options.running ? [{ text: heading, y: 30 }] : []),
          ...(options.duplicate ? [{ text: heading, y: 600 }] : []),
          { text: nextHeading, y: 160 },
          { text: "Further passage in the next section", y: 200 },
        ],
      },
    ],
  };
}

function decide(options: Options = {}) {
  return decideSectionEvidence({
    section: options.section ?? a4,
    outline: options.outline ?? [a4, b21],
    pageText: options.pageText ?? pageText,
    variantPageCount: options.variantPageCount ?? 3,
    layout: layout(options),
  });
}

test("a unique body heading and its next heading verify a section", () => {
  const decision = decide();
  assert.equal(decision.status, "verified");
  assert.deepEqual(decision.reasons, []);
  assert.deepEqual(decision.headingAnchor, { page: 2, text: heading, y: 140 });
  assert.deepEqual(decision.boundary, {
    page: 3,
    text: nextHeading,
    y: 160,
  });
  assert.match(decision.surroundingText ?? "", /A\.4 Steuerliche Behandlung/);
  assert.ok(pageText.indexOf("A.4") > 2000);
  assert.deepEqual(decision.headingLines, [{ text: heading, y: 140 }]);
  assert.deepEqual(decision.nextHeadingLines, [{ text: nextHeading, y: 160 }]);
});

test("contents page, running header, duplicate heading and top margin cannot anchor a section", () => {
  for (const options of [
    { contents: true },
    { running: true },
    { duplicate: true },
    { margin: true },
  ]) {
    const decision = decide(options);
    assert.equal(decision.status, "ambiguous", JSON.stringify(options));
    assert.equal(decision.headingAnchor, null, JSON.stringify(options));
  }
});

test("a page shared with another section stays ambiguous", () => {
  const decision = decide({
    shared: true,
    outline: [a4, { ...b21, startPage: 2 }],
  });
  assert.equal(decision.status, "ambiguous");
  assert.ok(
    decision.reasons.includes("Another section starts on the same page"),
  );
});

test("an unlisted heading inside the stored range keeps the section ambiguous", () => {
  const decision = decide({ intervening: true });
  assert.equal(decision.status, "ambiguous");
  assert.ok(
    decision.reasons.includes(
      "An unlisted heading appears inside the stored range",
    ),
  );
  assert.equal(decision.headingAnchor?.text, heading);
});

test("a stored range that disagrees with the PDF keeps the section ambiguous", () => {
  const decision = decide({ variantPageCount: 4 });
  assert.equal(decision.status, "ambiguous");
  assert.ok(
    decision.reasons.includes("Stored page range does not match the PDF"),
  );
});

test("stored page text without the heading keeps the section ambiguous", () => {
  const decision = decide({ pageText: "Preface without the heading" });
  assert.equal(decision.status, "ambiguous");
  assert.equal(decision.surroundingText, null);
  assert.ok(
    decision.reasons.includes("Stored page text does not contain the heading"),
  );
});

test("the last section ends at the document, not at a missing next heading", () => {
  const decision = decide({
    section: b21,
    pageText: `${nextHeading}\nFurther passage`,
  });
  assert.equal(decision.status, "verified");
  assert.deepEqual(decision.boundary, { page: 3, text: "Document end" });
  assert.equal(decision.nextHeadingLines, null);
});
