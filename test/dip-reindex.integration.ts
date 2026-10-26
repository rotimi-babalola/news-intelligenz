import assert from "node:assert/strict";
import { test } from "node:test";
import { retryJob } from "../src/admin/service.js";
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
    await Promise.all(
      ["first", "second"].map((referenceId) =>
        prisma.documentContent.create({
          data: {
            referenceId,
            variantNo: 1,
            byteHash: referenceId,
            byteSize: 1,
            pageCount: 2,
            pages: {
              create: [
                { pageNo: 1, text: "Parliamentary text" },
                { pageNo: 2, text: "" },
              ],
            },
          },
        }),
      ),
    );
    assert.deepEqual(await enqueueDipReindex(prisma, "model-c"), {
      proceedings: 1,
      steps: 0,
      pages: 2,
    });
    assert.deepEqual(await enqueueDipReindex(prisma, "model-c"), {
      proceedings: 0,
      steps: 0,
      pages: 0,
    });
    const otherModelJob = await prisma.processingJob.findFirstOrThrow({
      where: {
        runId: "embedding-reindex:model-c",
        operation: "embed_document",
      },
    });
    await prisma.processingJob.update({
      where: { id: otherModelJob.id },
      data: { status: "exhausted", attempts: 5 },
    });
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await retryJob(otherModelJob.id);
    } finally {
      console.error = originalError;
    }
    const unchangedJob = await prisma.processingJob.findUniqueOrThrow({
      where: { id: otherModelJob.id },
    });
    assert.equal(unchangedJob.status, "exhausted");
    assert.equal(unchangedJob.maxAttempts, 5);
    assert.match(
      unchangedJob.lastError ?? "",
      /requires embedding index model-c/,
    );
    assert.match(errors.join(" "), /requires embedding index model-c/);
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
