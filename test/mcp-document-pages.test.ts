import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { getDocumentPages } from "../src/dip/document-pages.js";
import { proceedingHandler } from "../src/mcp/proceeding.js";

const pdfUrl = "https://dserver.bundestag.de/btd/21/010/2110010.pdf";
const reference = {
  referenceId: "291522",
  stepApiId: "10",
  proceedingApiId: "340161",
  documentNumber: "21/1001",
  pdfUrl,
  metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
  step: { institution: "BT", documentType: "Drucksache" },
};

function fixture(options: { eligible?: boolean; variant?: boolean } = {}) {
  const reads: string[] = [];
  const prisma = {
    documentReference: {
      findFirst: async () => {
        reads.push("reference");
        return options.eligible === false
          ? { ...reference, metadata: {} }
          : reference;
      },
    },
    documentContent: {
      findFirst: async (args: { where: { isLatest: boolean } }) => {
        reads.push("variant");
        assert.equal(args.where.isLatest, true);
        return options.variant === false
          ? null
          : {
              id: "latest",
              variantNo: 2,
              sourceUrl: "https://dserver.bundestag.de/latest.pdf",
            };
      },
    },
    documentPage: {
      findMany: async (args: {
        where: { contentId: string; pageNo: { gte: number } };
        take: number;
      }) => {
        reads.push("pages");
        assert.equal(args.where.contentId, "latest");
        assert.equal(args.where.pageNo.gte, 2);
        assert.equal(args.take, 2);
        return [
          { pageNo: 2, text: "A".repeat(2100) },
          { pageNo: 3, text: "New variant" },
        ];
      },
    },
  } as unknown as PrismaClient;
  return { prisma, reads };
}

test("eligible pages are bounded, attributed, and read from the latest variant", async () => {
  const { prisma, reads } = fixture();
  const result = await getDocumentPages(prisma, "291522", 2, 2);
  assert.equal(result.status, "available");
  assert.deepEqual(reads, ["reference", "variant", "pages"]);
  assert.equal(result.source?.pdfUrl, pdfUrl);
  assert.equal(result.variant?.variantNo, 2);
  assert.equal(
    result.eligibility?.source,
    "Deutscher Bundestag/Bundesrat – DIP",
  );
  assert.equal(result.eligibility?.document, "BT-Drs. 21/1001");
  assert.deepEqual(
    result.pages?.map((page) => page.page),
    [2, 3],
  );
  assert.equal(result.pages?.[0]?.text.length, 2000);
  assert.equal(result.pages?.[0]?.truncated, true);
  assert.equal(result.pages?.[1]?.text, "New variant");
  assert.equal(JSON.stringify(result).includes("old variant"), false);
});

test("missing extraction and ineligible references never read page text or queue jobs", async () => {
  const missing = fixture({ variant: false });
  const unavailable = await getDocumentPages(missing.prisma, "291522", 2, 2);
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(missing.reads, ["reference", "variant"]);
  const ineligible = fixture({ eligible: false });
  const metadata = await getDocumentPages(ineligible.prisma, "291522", 2, 2);
  assert.equal(metadata.status, "metadata-only");
  assert.equal(metadata.source?.pdfUrl, pdfUrl);
  assert.equal("pages" in metadata, false);
  assert.deepEqual(ineligible.reads, ["reference"]);
});

test("MCP validates page bounds before database access", async () => {
  const { prisma, reads } = fixture();
  const handler = proceedingHandler(prisma);
  try {
    for (const args of [
      { referenceId: "bad" },
      { referenceId: "291522", startPage: 0 },
      { referenceId: "291522", limit: 4 },
    ]) {
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
            params: { name: "get_document_pages", arguments: args },
          }),
        }),
      );
      const result = JSON.parse(
        (await response.text()).split("data: ")[1]!.trim(),
      );
      assert.equal(result.result.isError, true);
    }
    assert.deepEqual(reads, []);
  } finally {
    await handler.close();
  }
});
