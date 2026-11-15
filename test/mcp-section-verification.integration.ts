import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyDocumentSection } from "../src/dip/documents/verify.js";
import { isolatedDatabase } from "./dip-test-db.js";

test("section verification reads the latest eligible variant and does not create jobs", async () => {
  const prisma = await isolatedDatabase();
  const bytes = Buffer.from("archived section fixture");
  const pdfUrl = "https://dserver.bundestag.de/section.pdf";
  try {
    await prisma.proceedingStep.create({
      data: {
        apiId: "10",
        proceedingApiId: "1",
        institution: "BT",
        stepLabel: "Beratung",
        title: "Test",
        documentType: "Drucksache",
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: {},
      },
    });
    await prisma.documentReference.create({
      data: {
        stepApiId: "10",
        proceedingApiId: "1",
        referenceId: "291522",
        documentNumber: "21/1001",
        pdfUrl,
        metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
      },
    });
    await prisma.documentContent.create({
      data: {
        referenceId: "291522",
        variantNo: 1,
        byteHash: "old",
        byteSize: 3,
        pageCount: 1,
        requestedUrl: pdfUrl,
        isLatest: false,
        pages: { create: { pageNo: 1, text: "Old section" } },
      },
    });
    await prisma.documentContent.create({
      data: {
        referenceId: "291522",
        variantNo: 2,
        byteHash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
        pageCount: 2,
        requestedUrl: pdfUrl,
        sourceUrl: pdfUrl,
        objectKey: "archive.pdf",
        isLatest: true,
        pages: {
          create: [
            { pageNo: 1, text: "A.4 Steuerliche Behandlung\nPassage" },
            { pageNo: 2, text: "Further passage" },
          ],
        },
        sections: {
          create: {
            sectionNo: 1,
            label: "A.4",
            title: "Steuerliche Behandlung",
            startPage: 1,
            endPage: 2,
          },
        },
      },
    });
    const jobsBefore = await prisma.processingJob.count();
    const result = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => bytes,
      async () => ({
        pageCount: 2,
        occurrences: [{ page: 1, text: "A.4 Steuerliche Behandlung", y: 150 }],
        intervening: [],
        pages: [
          {
            page: 1,
            height: 800,
            lines: [
              { text: "A.4 Steuerliche Behandlung", y: 150 },
              { text: "Passage from the document body", y: 200 },
            ],
          },
          { page: 2, height: 800, lines: [] },
        ],
      }),
    );
    assert.equal(result.status, "verified");
    assert.equal(result.variant?.variantNo, 2);
    assert.equal(result.boundary?.text, "Document end");
    assert.equal(await prisma.processingJob.count(), jobsBefore);
    await prisma.documentReference.update({
      where: { stepApiId: "10" },
      data: { pdfUrl: `${pdfUrl}?revised` },
    });
    const changed = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => {
        throw new Error("must not read archive");
      },
    );
    assert.equal(changed.status, "unavailable");
  } finally {
    await prisma.$disconnect();
  }
});
