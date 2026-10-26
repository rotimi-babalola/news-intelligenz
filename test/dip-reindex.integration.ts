import assert from "node:assert/strict";
import { test } from "node:test";
import { processNextDipEmbedding } from "../src/dip/embedding.js";
import { enqueueDipReindex } from "../src/dip/reindex.js";
import { collectVorgang } from "../src/dip/vorgang.js";
import { isolatedDatabase } from "./dip-test-db.js";

test("reindex queues each model once and keeps both vector spaces separate", async () => {
  const prisma = await isolatedDatabase();
  const previousModel = process.env.EMBEDDING_MODEL;
  const previousIndexId = process.env.EMBEDDING_INDEX_ID;
  const previousBaseUrl = process.env.EMBEDDING_BASE_URL;
  const previousFormat = process.env.EMBEDDING_API_FORMAT;
  try {
    await collectVorgang(prisma, {
      runId: "reindex-source",
      electoralTerm: 21,
      fetchPage: async () => ({
        documents: [
          {
            id: "123",
            typ: "Vorgang",
            vorgangstyp: "Gesetzentwurf",
            wahlperiode: 21,
            titel: "Wohnraumgesetz",
            aktualisiert: "2026-10-14T12:00:00+02:00",
          },
        ],
        cursor: "x",
        numFound: 1,
      }),
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-sample", 10), {
      proceedings: 0,
      steps: 0,
      pages: 0,
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-sample", 100), {
      proceedings: 1,
      steps: 0,
      pages: 0,
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-a"), {
      proceedings: 1,
      steps: 0,
      pages: 0,
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-a"), {
      proceedings: 0,
      steps: 0,
      pages: 0,
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-b"), {
      proceedings: 1,
      steps: 0,
      pages: 0,
    });
    process.env.EMBEDDING_BASE_URL = "https://example.com/v1";
    process.env.EMBEDDING_API_FORMAT = "openai";
    const embed = async () => Array(1024).fill(0.1) as number[];
    process.env.EMBEDDING_MODEL = "model-a";
    process.env.EMBEDDING_INDEX_ID = "model-a";
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "model-a-worker", {
          embed,
          reindexOnly: true,
        })
      ).status,
      "succeeded",
    );
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "model-a-worker", {
          embed,
          reindexOnly: true,
        })
      ).status,
      "empty",
    );
    assert.equal(
      await prisma.dipEmbedding.count({ where: { model: "model-a" } }),
      1,
    );
    assert.equal(
      await prisma.processingJob.count({
        where: {
          operation: "embed_proceeding",
          status: "pending",
          payload: { path: ["model"], equals: "model-b" },
        },
      }),
      1,
    );
    assert.equal(
      await prisma.processingJob.count({
        where: {
          runId: "reindex-source",
          operation: "embed_proceeding",
          status: "pending",
        },
      }),
      1,
    );
    process.env.EMBEDDING_MODEL = "model-b";
    process.env.EMBEDDING_INDEX_ID = "model-b";
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "model-b-worker", {
          embed,
          reindexOnly: true,
        })
      ).status,
      "succeeded",
    );
    assert.equal(await prisma.dipEmbedding.count(), 2);
  } finally {
    if (previousModel === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = previousModel;
    if (previousIndexId === undefined) delete process.env.EMBEDDING_INDEX_ID;
    else process.env.EMBEDDING_INDEX_ID = previousIndexId;
    if (previousBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = previousBaseUrl;
    if (previousFormat === undefined) delete process.env.EMBEDDING_API_FORMAT;
    else process.env.EMBEDDING_API_FORMAT = previousFormat;
    await prisma.$disconnect();
  }
});
