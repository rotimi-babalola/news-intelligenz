import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDocumentSections } from "../src/dip/sections.js";

test("omnibus headings produce ordered sections with page ranges and skip the contents list", () => {
  const sections = detectDocumentSections([
    {
      pageNo: 1,
      text: [
        "Deutscher Bundestag – Drucksache 21/1001",
        "Inhaltsverzeichnis",
        "A.4 Steuerliche Behandlung von Erbschaften .......... 2",
        "B.21 Förderung kommunaler Wärmepläne .......... 4",
      ].join("\n"),
    },
    {
      pageNo: 2,
      text: "A.4 Steuerliche Behandlung von Erbschaften\nDer Ausschuss empfiehlt ...",
    },
    { pageNo: 3, text: "Weitere Ausführungen zu A.4." },
    {
      pageNo: 4,
      text: "B.21 Förderung kommunaler Wärmepläne\nDie Bundesregierung wird ...",
    },
    { pageNo: 5, text: "Anlage" },
  ]);
  assert.deepEqual(sections, [
    {
      sectionNo: 1,
      label: "A.4",
      title: "Steuerliche Behandlung von Erbschaften",
      startPage: 2,
      endPage: 3,
    },
    {
      sectionNo: 2,
      label: "B.21",
      title: "Förderung kommunaler Wärmepläne",
      startPage: 4,
      endPage: 5,
    },
  ]);
});

test("a contents page without leader dots does not shift the body page ranges", () => {
  const sections = detectDocumentSections([
    {
      pageNo: 1,
      text: "Inhaltsverzeichnis\nA.4 Steuerliche Behandlung\nB.21 Förderung",
    },
    { pageNo: 2, text: "A.4 Steuerliche Behandlung\nText" },
    { pageNo: 3, text: "B.21 Förderung\nText" },
  ]);
  assert.deepEqual(
    sections.map((section) => [
      section.label,
      section.startPage,
      section.endPage,
    ]),
    [
      ["A.4", 2, 2],
      ["B.21", 3, 3],
    ],
  );
});

test("headings sharing a page stay on that page and the last section reaches the final page", () => {
  const sections = detectDocumentSections([
    {
      pageNo: 1,
      text: "I. Vorbemerkung\nA. Problem\nB. Lösung",
    },
    { pageNo: 2, text: "C. Alternativen" },
  ]);
  assert.deepEqual(
    sections.map((section) => [
      section.label,
      section.startPage,
      section.endPage,
    ]),
    [
      ["I.", 1, 1],
      ["A.", 1, 1],
      ["B.", 1, 1],
      ["C.", 2, 2],
    ],
  );
});

test("repeated running headers do not start new sections", () => {
  const sections = detectDocumentSections([
    { pageNo: 1, text: "A.4 Steuerliche Behandlung" },
    { pageNo: 2, text: "A.4 Steuerliche Behandlung\nMehr Text" },
    { pageNo: 3, text: "B.21 Förderung" },
  ]);
  assert.deepEqual(
    sections.map((section) => [
      section.label,
      section.startPage,
      section.endPage,
    ]),
    [
      ["A.4", 1, 2],
      ["B.21", 3, 3],
    ],
  );
});

test("bare labels, prose, and contents entries never invent a section", () => {
  assert.deepEqual(
    detectDocumentSections([
      {
        pageNo: 1,
        text: [
          "A.4",
          "A.4 Steuerliche Behandlung von Erbschaften 12",
          "a.4 Steuerliche Behandlung",
          "Der Ausschuss empfiehlt die Annahme.",
          "B.21",
        ].join("\n"),
      },
    ]),
    [],
  );
  assert.deepEqual(detectDocumentSections([]), []);
});
