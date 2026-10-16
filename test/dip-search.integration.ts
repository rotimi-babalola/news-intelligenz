import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DOCUMENT_INSTRUCTION,
  EMBEDDING_MODEL,
  processNextProceedingEmbedding,
  QUERY_INSTRUCTION,
} from "../src/dip/embedding.js";
import { saveDipEmbedding } from "../src/dip/repository.js";
import { searchDip } from "../src/dip/search.js";
import type { VorgangPage } from "../src/dip/types.js";
import { collectVorgang } from "../src/dip/vorgang.js";
import { isolatedDatabase } from "./dip-test-db.js";

const vector = (first: number, second: number) => [
  first,
  second,
  ...Array.from({ length: 1022 }, () => 0),
];

test("German and English queries return only current DIP source versions", async () => {
  const prisma = await isolatedDatabase();
  try {
    await prisma.proceeding.create({
      data: {
        apiId: "123",
        title: "Freigabe von Erdölvorräten",
        proceedingType: "Rechtsverordnung",
        electoralTerm: 21,
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: { abstract: "Vorräte des Erdölbevorratungsverbandes" },
        latestVersionNo: 2,
      },
    });
    await prisma.proceedingStep.create({
      data: {
        apiId: "456",
        proceedingApiId: "123",
        institution: "BR",
        stepLabel: "Verordnung der Bundesregierung",
        title: "Freigabe von Erdölvorräten",
        documentType: "Drucksache",
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: { abstract: "Beratung über Erdölreserven" },
        latestVersionNo: 1,
      },
    });
    const save = (
      sourceEntity: "vorgang" | "vorgangsposition",
      sourceApiId: string,
      sourceVersionNo: number,
      embedding: number[],
    ) =>
      saveDipEmbedding(prisma, {
        sourceEntity,
        apiId: sourceApiId,
        versionNo: sourceVersionNo,
        model: EMBEDDING_MODEL,
        documentInstruction: DOCUMENT_INSTRUCTION,
        queryInstruction: QUERY_INSTRUCTION,
        embedding,
      });
    await save("vorgang", "123", 1, vector(1, 0));
    await save("vorgang", "123", 2, vector(0.8, 0.6));
    await save("vorgangsposition", "456", 1, vector(1, 0));
    const queries: string[] = [];
    const embed = async (text: string) => {
      queries.push(text);
      return vector(1, 0);
    };
    const german = await searchDip(prisma, "Erdölreserven freigeben", 10, {
      embed,
    });
    const english = await searchDip(prisma, "release petroleum reserves", 10, {
      embed,
    });
    await assert.rejects(
      searchDip(prisma, "zero vector", 10, {
        embed: async () => vector(0, 0),
      }),
      /invalid 1024-dimensional embedding/,
    );
    assert.deepEqual(queries, [
      `Instruct: ${QUERY_INSTRUCTION}\nQuery:Erdölreserven freigeben`,
      `Instruct: ${QUERY_INSTRUCTION}\nQuery:release petroleum reserves`,
    ]);
    for (const matches of [german, english]) {
      assert.deepEqual(
        matches.map(({ entity, apiId, versionNo }) => ({
          entity,
          apiId,
          versionNo,
        })),
        [
          { entity: "vorgangsposition", apiId: "456", versionNo: 1 },
          { entity: "vorgang", apiId: "123", versionNo: 2 },
        ],
      );
      assert.deepEqual(matches[0]?.source, {
        endpoint: "/vorgangsposition",
        apiId: "456",
        url: "https://search.dip.bundestag.de/api/v1/vorgangsposition/456",
      });
      assert.equal(matches[0]?.proceedingApiId, "123");
      assert.equal(
        matches[1]?.summary,
        "Vorräte des Erdölbevorratungsverbandes",
      );
      assert.ok(matches[0]!.score > matches[1]!.score);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test(
  "real Qwen embeddings retrieve the same German DIP proceeding from German and English queries",
  { skip: process.env.OLLAMA_QA !== "1" },
  async () => {
    const prisma = await isolatedDatabase();
    try {
      const page = JSON.parse(
        await readFile("fixtures/dip/vorgang-page1.json", "utf8"),
      ) as VorgangPage;
      const collect = (runId: string, documents: unknown[]) =>
        collectVorgang(prisma, {
          runId,
          electoralTerm: 21,
          fetchPage: async () => ({ ...page, documents, cursor: "" }),
        });
      assert.equal(
        (await collect("search-v1", page.documents)).versionsAdded,
        3,
      );
      for (let i = 0; i < 3; i++)
        assert.equal(
          (await processNextProceedingEmbedding(prisma, "search-qa")).status,
          "succeeded",
        );
      const changed = {
        ...(page.documents[0] as Record<string, unknown>),
        sachgebiet: ["Wirtschaft", "Energie"],
      };
      assert.equal((await collect("search-v2", [changed])).versionsAdded, 1);
      assert.equal(
        (await processNextProceedingEmbedding(prisma, "search-qa")).status,
        "succeeded",
      );

      for (const query of [
        "Freigabe von Erdölvorräten",
        "release of petroleum reserves",
      ]) {
        const results = await searchDip(prisma, query, 10);
        assert.equal(results[0]?.apiId, "340161");
        assert.equal(results[0]?.versionNo, 2);
        assert.equal(results[0]?.source.endpoint, "/vorgang");
        assert.equal(
          results.filter((result) => result.apiId === "340161").length,
          1,
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  },
);
