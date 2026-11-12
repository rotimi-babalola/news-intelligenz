import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { proceedingHandler } from "../src/mcp/proceeding.js";

async function call(
  handler: ReturnType<typeof proceedingHandler>,
  id: number,
  args: object,
) {
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
        id,
        method: "tools/call",
        params: {
          name: "search_dip_evidence",
          arguments: args,
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  return JSON.parse((await response.text()).split("data: ")[1]!.trim()).result;
}

test("MCP search accepts German and English queries and returns current DIP evidence", async (t) => {
  const originalFormat = process.env.EMBEDDING_API_FORMAT;
  process.env.EMBEDDING_API_FORMAT = "ollama";
  const queries: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)).input);
      return Response.json({ embeddings: [Array(1024).fill(0.1)] });
    },
  );
  const rows = [
    {
      entity: "dokument",
      apiId: "291522",
      versionNo: 2,
      score: 0.8,
      documentNumber: "583/26",
      proceedingApiId: "340161",
      referenceId: "291522",
      pdfUrl: "https://example.org/document.pdf",
      requestedUrl: "https://example.org/document.pdf",
      institution: "BR",
      documentType: "Drucksache",
      referenceMetadata: {},
      stepId: "10",
      pageNo: 3,
      chunkNo: 1,
      passage: "Energy reserves",
    },
  ];
  const sql: string[] = [];
  const prisma = {
    $transaction: async (run: (client: PrismaClient) => Promise<unknown>) =>
      run(prisma as unknown as PrismaClient),
    $queryRawUnsafe: async (query: string) => {
      sql.push(query);
      return rows;
    },
    proceeding: {
      findMany: async () => [
        {
          apiId: "340161",
          title: "Energy reserves",
          proceedingType: "Bill",
          deliberationState: null,
          documentDate: null,
          sourceUpdatedAt: new Date("2026-10-10"),
          firstObservedAt: new Date("2026-10-10"),
          lastObservedAt: new Date("2026-10-10"),
          latestVersionNo: 1,
          metadata: {},
          versions: [],
        },
      ],
    },
    proceedingStep: {
      findMany: async () => [
        {
          apiId: "10",
          proceedingApiId: "340161",
          institution: "BR",
          stepLabel: "Beratung",
          title: "Energy reserves",
          documentType: "Drucksache",
          documentDate: null,
          sourceUpdatedAt: new Date("2026-10-10"),
          firstObservedAt: new Date("2026-10-10"),
          lastObservedAt: new Date("2026-10-10"),
          latestVersionNo: 1,
          metadata: {},
          versions: [],
          documentReference: {
            referenceId: "291522",
            documentNumber: "583/26",
            documentDate: null,
            pdfUrl: "https://example.org/document.pdf",
            metadata: {},
            observedAt: new Date("2026-10-10"),
          },
        },
      ],
    },
  } as unknown as PrismaClient;
  const handler = proceedingHandler(prisma);
  try {
    for (const [id, query] of [
      [1, "Erdölreserven"],
      [2, "petroleum reserves"],
    ] as const) {
      const result = await call(handler, id, { query, limit: 1 });
      assert.equal(result.isError, undefined);
      const dossier = JSON.parse(result.content[0].text).results[0];
      assert.equal(dossier.apiId, "340161");
      assert.equal(dossier.steps[0].apiId, "10");
      const evidence = dossier.evidence[0];
      assert.equal(evidence.entity, "dokument");
      assert.equal(evidence.apiId, "291522");
      assert.equal(evidence.proceedingApiId, "340161");
      assert.equal(evidence.source.apiId, "10");
      assert.equal(evidence.versionNo, 2);
      assert.equal(evidence.score, 0.8);
      assert.equal(evidence.page, 3);
      assert.equal(evidence.source.url, "https://example.org/document.pdf");
    }
    assert.equal(queries.length, 2);
    assert.match(queries[0]!, /Erdölreserven/);
    assert.match(queries[1]!, /petroleum reserves/);
    assert.ok(
      sql.every(
        (query) =>
          query.includes("latest_version_no") && query.includes("c.is_latest"),
      ),
    );
  } finally {
    await handler.close();
    if (originalFormat === undefined) delete process.env.EMBEDDING_API_FORMAT;
    else process.env.EMBEDDING_API_FORMAT = originalFormat;
  }
});

test("MCP search rejects invalid input and reports provider or index errors", async (t) => {
  const originalFormat = process.env.EMBEDDING_API_FORMAT;
  process.env.EMBEDDING_API_FORMAT = "ollama";
  let reads = 0;
  const prisma = {
    $transaction: async (run: (client: PrismaClient) => Promise<unknown>) =>
      run(prisma as unknown as PrismaClient),
    $queryRawUnsafe: async () => {
      reads++;
      throw new Error("DIP index unavailable");
    },
  } as unknown as PrismaClient;
  const handler = proceedingHandler(prisma);
  try {
    for (const args of [
      { query: " ", limit: 1 },
      { query: "test", limit: 0 },
      { query: "test", limit: 21 },
    ]) {
      const result = await call(handler, 3, args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Input validation error/);
    }
    assert.equal(reads, 0);
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const provider = await call(handler, 4, { query: "test" });
    assert.equal(provider.isError, true);
    assert.match(provider.content[0].text, /^DIP search unavailable$/);
    assert.equal(reads, 0);
    t.mock.restoreAll();
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ embeddings: [Array(1024).fill(0.1)] }),
    );
    const index = await call(handler, 5, { query: "test" });
    assert.equal(index.isError, true);
    assert.match(index.content[0].text, /^DIP search unavailable$/);
    assert.equal(reads, 1);
  } finally {
    await handler.close();
    if (originalFormat === undefined) delete process.env.EMBEDDING_API_FORMAT;
    else process.env.EMBEDDING_API_FORMAT = originalFormat;
  }
});
