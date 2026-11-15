import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { verifyDocumentSection } from "../src/dip/documents/verify.js";

const pdfUrl = "https://dserver.bundestag.de/section.pdf";
const bytes = Buffer.from("archived PDF fixture");
const byteHash = createHash("sha256").update(bytes).digest("hex");
const text = `${"Preface ".repeat(300)}A.4 Steuerliche Behandlung\nA passage to cite`;

function fixture(
  options: {
    eligible?: boolean;
    changed?: boolean;
    shared?: boolean;
    contents?: boolean;
    running?: boolean;
    intervening?: boolean;
  } = {},
) {
  const reads: string[] = [];
  const prisma = {
    documentReference: {
      findFirst: async () => {
        reads.push("reference");
        return {
          pdfUrl: options.changed ? `${pdfUrl}?revised` : pdfUrl,
          documentNumber: "21/1001",
          metadata:
            options.eligible === false
              ? {}
              : { herausgeber: "BT", dokumentart: "Drucksache" },
          step: { institution: "BT", documentType: "Drucksache" },
        };
      },
    },
    documentContent: {
      findFirst: async () => {
        reads.push("variant");
        return {
          id: "current",
          variantNo: 2,
          byteHash,
          objectKey: "archive.pdf",
          requestedUrl: pdfUrl,
          sourceUrl: pdfUrl,
          pageCount: 3,
        };
      },
    },
    documentSection: {
      findMany: async () => {
        reads.push("sections");
        return [
          {
            sectionNo: 1,
            label: "A.4",
            title: "Steuerliche Behandlung",
            startPage: 2,
            endPage: options.shared ? 2 : 2,
          },
          {
            sectionNo: 2,
            label: "B.21",
            title: "Förderung",
            startPage: options.shared ? 2 : 3,
            endPage: 3,
          },
        ];
      },
    },
    documentPage: {
      findUnique: async () => {
        reads.push("page");
        return { pageNo: 2, text };
      },
    },
  } as unknown as PrismaClient;
  const inspect = async () => ({
    pageCount: 3,
    occurrences: [
      { page: 2, text: "A.4 Steuerliche Behandlung", y: 140 },
      { page: options.shared ? 2 : 3, text: "B.21 Förderung", y: 160 },
      ...(options.running
        ? [{ page: 1, text: "A.4 Steuerliche Behandlung", y: 30 }]
        : []),
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
          { text: "A.4 Steuerliche Behandlung", y: 140 },
          { text: "A passage to cite in the body", y: 180 },
          ...(options.shared ? [{ text: "B.21 Förderung", y: 400 }] : []),
        ],
      },
      {
        page: 3,
        height: 800,
        lines: [
          ...(options.running
            ? [{ text: "A.4 Steuerliche Behandlung", y: 30 }]
            : []),
          { text: "B.21 Förderung", y: 160 },
          { text: "Further passage in the next section", y: 200 },
        ],
      },
    ],
  });
  return { prisma, reads, inspect };
}

test("verifies a current section from PDF positions and full stored page context", async () => {
  const { prisma, inspect } = fixture();
  const result = await verifyDocumentSection(
    prisma,
    "291522",
    1,
    async () => bytes,
    inspect,
  );
  assert.equal(result.status, "verified");
  assert.equal(result.variant?.byteHash, byteHash);
  assert.equal(
    result.source?.attribution,
    "Deutscher Bundestag/Bundesrat – DIP",
  );
  assert.equal(result.headingAnchor?.text, "A.4 Steuerliche Behandlung");
  assert.equal(result.boundary?.text, "B.21 Förderung");
  assert.equal(result.section?.endPage, 2);
  assert.match(result.surroundingText ?? "", /A\.4 Steuerliche Behandlung/);
  assert.ok(text.indexOf("A.4") > 2000);
});

test("contents entry or repeated running header cannot verify a section", async () => {
  for (const options of [{ contents: true }, { running: true }]) {
    const { prisma, inspect } = fixture(options);
    const result = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => bytes,
      inspect,
    );
    assert.equal(result.status, "ambiguous");
  }
});

test("shared-page boundary is explicitly ambiguous", async () => {
  const { prisma, inspect } = fixture({ shared: true });
  const result = await verifyDocumentSection(
    prisma,
    "291522",
    1,
    async () => bytes,
    inspect,
  );
  assert.equal(result.status, "ambiguous");
});

test("an intervening PDF heading prevents a stored range from being verified", async () => {
  const { prisma, inspect } = fixture({ intervening: true });
  const result = await verifyDocumentSection(
    prisma,
    "291522",
    1,
    async () => bytes,
    inspect,
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(
    result.evidence?.interveningHeadings[0]?.text,
    "C.1 Omitted heading",
  );
});

test("changed revision and ineligible reference never expose page text or read the PDF", async () => {
  for (const options of [{ changed: true }, { eligible: false }]) {
    const { prisma, reads, inspect } = fixture(options);
    const result = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => {
        throw new Error("should not read PDF");
      },
      inspect,
    );
    assert.equal(
      result.status,
      options.changed ? "unavailable" : "metadata-only",
    );
    assert.equal("surroundingText" in result, false);
    assert.deepEqual(
      reads,
      options.changed ? ["reference", "variant"] : ["reference"],
    );
  }
});
