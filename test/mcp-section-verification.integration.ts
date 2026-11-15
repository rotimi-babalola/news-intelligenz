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
    const inspect = async () => ({
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
    });
    const jobsBefore = await prisma.processingJob.count();
    const result = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => bytes,
      inspect,
    );
    assert.equal(result.status, "verified");
    assert.equal(result.variant?.variantNo, 2);
    assert.equal(result.boundary?.text, "Document end");
    assert.equal(await prisma.processingJob.count(), jobsBefore);
    const content = await prisma.documentContent.findFirst({
      where: { referenceId: "291522", isLatest: true },
    });
    await prisma.documentSection.create({
      data: {
        contentId: content!.id,
        sectionNo: 2,
        label: "B.21",
        title: "Förderung",
        startPage: 1,
        endPage: 2,
      },
    });
    const ambiguous = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => bytes,
      inspect,
    );
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(ambiguous.headingAnchor?.text, "A.4 Steuerliche Behandlung");
    const mismatched = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => Buffer.from("other bytes"),
      inspect,
    );
    assert.equal(mismatched.status, "unavailable");
    assert.equal(mismatched.reason, "Archived PDF hash mismatch");
    const uninspected = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => bytes,
      async () => {
        throw new Error("inspector unavailable");
      },
    );
    assert.equal(uninspected.status, "unavailable");
    assert.equal(uninspected.reason, "PDF inspection unavailable");
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
    await prisma.documentReference.update({
      where: { stepApiId: "10" },
      data: { metadata: {} },
    });
    const ineligible = await verifyDocumentSection(
      prisma,
      "291522",
      1,
      async () => {
        throw new Error("must not read archive");
      },
    );
    assert.equal(ineligible.status, "metadata-only");
    assert.equal("surroundingText" in ineligible, false);
  } finally {
    await prisma.$disconnect();
  }
});
