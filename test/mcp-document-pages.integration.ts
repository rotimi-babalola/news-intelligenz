import assert from "node:assert/strict";
import { test } from "node:test";
import { proceedingHandler } from "../src/mcp/proceeding.js";
import { isolatedDatabase } from "./dip-test-db.js";

test("MCP page reads use only the latest eligible variant without changing jobs", async () => {
  const prisma = await isolatedDatabase();
  const handler = proceedingHandler(prisma);
  async function read(referenceId: string) {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_document_pages",
            arguments: { referenceId, startPage: 1, limit: 2 },
          },
        }),
      }),
    );
    const envelope = JSON.parse(
      (await response.text()).split("data: ")[1]!.trim(),
    );
    assert.equal(envelope.result.isError, undefined);
    return JSON.parse(envelope.result.content[0].text);
  }
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
    const reference = await prisma.documentReference.create({
      data: {
        stepApiId: "10",
        proceedingApiId: "1",
        referenceId: "291522",
        documentNumber: "21/1001",
        pdfUrl: "https://dserver.bundestag.de/example.pdf",
        metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
      },
    });
    const jobsBefore = await prisma.processingJob.count();
    assert.equal((await read("291522")).status, "unavailable");
    assert.equal((await read("999999")).status, "unknown");
    await prisma.documentReference.update({
      where: { stepApiId: reference.stepApiId },
      data: { metadata: {} },
    });
    const ineligible = await read("291522");
    assert.equal(ineligible.status, "metadata-only");
    assert.equal("pages" in ineligible, false);
    await prisma.documentReference.update({
      where: { stepApiId: reference.stepApiId },
      data: { metadata: { herausgeber: "BT", dokumentart: "Drucksache" } },
    });
    for (const [variantNo, isLatest, text] of [
      [1, false, "Old variant"],
      [2, true, "Current variant"],
    ] as const) {
      await prisma.documentContent.create({
        data: {
          referenceId: "291522",
          variantNo,
          byteHash: `hash-${variantNo}`,
          byteSize: 10,
          pageCount: 1,
          isLatest,
          pages: { create: { pageNo: 1, text } },
        },
      });
    }
    const current = await read("291522");
    assert.equal(current.status, "available");
    assert.equal(current.variant.variantNo, 2);
    assert.deepEqual(current.pages, [
      { page: 1, text: "Current variant", truncated: false },
    ]);
    assert.equal(await prisma.processingJob.count(), jobsBefore);
  } finally {
    await handler.close();
    await prisma.$disconnect();
  }
});
