import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/dip/repository.js";
import {
  backfillDocumentSections,
  detectDocumentSections,
} from "../src/dip/sections.js";

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

test("bare labels, unlabeled prose, and contents entries never invent a section", () => {
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

test("a labeled prose sentence is not a section heading", () => {
  assert.deepEqual(
    detectDocumentSections([
      { pageNo: 1, text: "A. Problem" },
      {
        pageNo: 2,
        text: "B. Der Ausschuss empfiehlt die Annahme des Gesetzes.",
      },
    ]),
    [{ sectionNo: 1, label: "A.", title: "Problem", startPage: 1, endPage: 2 }],
  );
});

test("backfill outlines latest variants once and leaves existing outlines alone", async () => {
  const created: { contentId: string; sectionNo: number }[] = [];
  const client = {
    documentContent: {
      findMany: async (args: { where: { isLatest: boolean } }) => {
        assert.equal(args.where.isLatest, true);
        return [{ id: "with-heading" }, { id: "without-heading" }];
      },
    },
    documentPage: {
      findMany: async (args: { where: { contentId: string } }) => [
        {
          pageNo: 1,
          text:
            args.where.contentId === "with-heading"
              ? "A.4 Steuerliche Behandlung\nText"
              : "Nur Fließtext ohne Gliederung",
        },
      ],
    },
    documentSection: {
      findMany: async (args: { where: { contentId: string } }) =>
        created.filter((row) => row.contentId === args.where.contentId),
      createMany: async (args: {
        data: { contentId: string; sectionNo: number }[];
      }) => {
        created.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as Client;
  assert.deepEqual(await backfillDocumentSections(client), {
    variants: 2,
    outlines: 1,
  });
  assert.equal(created.length, 1);
  assert.deepEqual(await backfillDocumentSections(client), {
    variants: 2,
    outlines: 1,
  });
  assert.equal(created.length, 1);
});
