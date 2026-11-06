import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { getProceeding } from "../src/dip/proceeding.js";
import { proceedingHandler } from "../src/mcp/proceeding.js";

const date = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);
const step = (apiId: string, day: number | null) => ({
  apiId,
  proceedingApiId: "340161",
  institution: "BR",
  stepLabel: "Beratung",
  title: `Step ${apiId}`,
  documentType: "Drucksache",
  documentDate: day === null ? null : date(day),
  sourceUpdatedAt: date(20),
  firstObservedAt: date(21),
  lastObservedAt: date(22),
  latestVersionNo: 2,
  metadata: {},
  versions: [{ id: `version-${apiId}`, observedAt: date(21) }],
  documentReference: null,
});

function client(parent: object | null, steps: object[]): PrismaClient {
  return {
    proceeding: { findUnique: async () => parent },
    proceedingStep: { findMany: async () => steps },
  } as unknown as PrismaClient;
}

test("getProceeding returns current state and a deterministic step timeline", async () => {
  const late = step("20", 12);
  const early = {
    ...step("10", 10),
    metadata: { text: "Beratungstext" },
    documentReference: {
      referenceId: "291522",
      documentNumber: "583/26",
      documentDate: date(10),
      pdfUrl: "https://example.org/document.pdf",
      metadata: { drucksachetyp: "Verordnung" },
      observedAt: date(21),
    },
  };
  const undated = step("30", null);
  const result = await getProceeding(
    client(
      {
        apiId: "340161",
        title: "Vorräte",
        proceedingType: "Rechtsverordnung",
        deliberationState: null,
        documentDate: date(9),
        sourceUpdatedAt: date(20),
        firstObservedAt: date(21),
        lastObservedAt: date(22),
        latestVersionNo: 2,
        metadata: { abstract: "Zusammenfassung" },
        versions: [{ id: "version-p", observedAt: date(21) }],
      },
      [undated, late, early, step("2", 10)],
    ),
    "340161",
  );
  assert.equal(result?.proceeding?.summary, "Zusammenfassung");
  assert.equal(result?.proceeding?.deliberationState, null);
  assert.equal(result?.proceeding?.versionId, "version-p");
  assert.notEqual(
    result?.proceeding?.sourceUpdatedAt,
    result?.proceeding?.firstObservedAt,
  );
  assert.deepEqual(
    result?.steps.map((s) => s.apiId),
    ["2", "10", "20", "30"],
  );
  assert.equal(result?.steps[1]?.text, "Beratungstext");
  assert.equal(
    result?.steps[1]?.document?.pdfUrl,
    "https://example.org/document.pdf",
  );
  assert.deepEqual(result?.steps[1]?.document?.metadata, {
    drucksachetyp: "Verordnung",
  });
  assert.equal(result?.steps[2]?.document, null);
  assert.equal(result?.steps[3]?.documentDate, null);
});

test("getProceeding exposes orphan steps and distinguishes missing records", async () => {
  const orphan = await getProceeding(client(null, [step("10", 10)]), "340161");
  assert.equal(orphan?.parentMissing, true);
  assert.equal(orphan?.proceeding, null);
  assert.equal(orphan?.steps.length, 1);
  assert.equal(await getProceeding(client(null, []), "340161"), null);
  await assert.rejects(getProceeding(client(null, []), "bad"), /numeric/);
});

test("MCP discovers get_proceeding and reports invalid and missing IDs", async () => {
  const handler = proceedingHandler(client(null, []));
  async function request(id: number, method: string, params: object) {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
    assert.equal(response.status, 200);
    return JSON.parse((await response.text()).split("data: ")[1]!.trim());
  }
  try {
    const listing = await request(1, "tools/list", {});
    assert.deepEqual(
      listing.result.tools.map((tool: { name: string }) => tool.name),
      ["get_proceeding"],
    );
    const missing = await request(2, "tools/call", {
      name: "get_proceeding",
      arguments: { apiId: "999" },
    });
    assert.equal(missing.result.isError, true);
    const invalid = await request(3, "tools/call", {
      name: "get_proceeding",
      arguments: { apiId: "bad" },
    });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /Input validation error/);
  } finally {
    await handler.close();
  }
});

test("MCP returns a partial timeline as JSON without a parent", async () => {
  const handler = proceedingHandler(client(null, [step("10", 10)]));
  try {
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
          id: 4,
          method: "tools/call",
          params: { name: "get_proceeding", arguments: { apiId: "340161" } },
        }),
      }),
    );
    const envelope = JSON.parse(
      (await response.text()).split("data: ")[1]!.trim(),
    );
    const timeline = JSON.parse(envelope.result.content[0].text);
    assert.equal(timeline.parentMissing, true);
    assert.equal(timeline.steps[0].apiId, "10");
  } finally {
    await handler.close();
  }
});
