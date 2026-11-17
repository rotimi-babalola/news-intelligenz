import assert from "node:assert/strict";
import { test } from "node:test";
import { retryJob } from "../src/admin/service.js";
import { embeddingConfig } from "../src/dip/search/embedding.js";
import {
  drainDipEmbeddings,
  processNextDipEmbedding,
} from "../src/dip/jobs/embedding.js";
import { EMBED_PROCEEDING, EMBED_STEP } from "../src/dip/constants.js";
import { collectVorgang } from "../src/dip/collection/proceedings.js";
import { collectSteps } from "../src/dip/collection/steps.js";
import { enqueueDocumentEmbeddings } from "../src/dip/jobs/queue.js";
import { dipSource, enqueueJob } from "../src/jobs/index.js";
import { qualifiedTable } from "../src/db.js";
import { isolatedDatabase } from "./dip-test-db.js";

function proceeding(title: string, withSummary = true) {
  return {
    id: "123",
    typ: "Vorgang",
    vorgangstyp: "Gesetzentwurf",
    wahlperiode: 21,
    titel: title,
    ...(withSummary ? { abstract: "Regelung für bezahlbaren Wohnraum." } : {}),
    aktualisiert: "2026-10-14T12:00:00+02:00",
  };
}

async function collect(
  prisma: Awaited<ReturnType<typeof isolatedDatabase>>,
  runId: string,
  title: string,
  withSummary = true,
) {
  await collectVorgang(prisma, {
    runId,
    electoralTerm: 21,
    fetchPage: async () => ({
      documents: [proceeding(title, withSummary)],
      cursor: "x",
      numFound: 1,
    }),
  });
}

// A run with one stored document variant whose passages are queued for
// embedding, which is the shape the drain's batched path handles.
async function queueDocumentPassages(
  prisma: Awaited<ReturnType<typeof isolatedDatabase>>,
  runId: string,
  texts: string[],
) {
  await prisma.run.create({
    data: {
      id: runId,
      feedId: "/vorgangsposition",
      inputHash: runId,
      status: "running",
    },
  });
  const content = await prisma.documentContent.create({
    data: {
      referenceId: runId,
      variantNo: 1,
      byteHash: runId,
      byteSize: texts.length,
      pageCount: texts.length,
    },
  });
  await prisma.documentChunk.createMany({
    data: texts.map((text, index) => ({
      contentId: content.id,
      pageNo: index + 1,
      chunkNo: 1,
      text,
    })),
  });
  await enqueueDocumentEmbeddings(prisma, {
    runId,
    itemIndex: null,
    electoralTerm: null,
    referenceId: runId,
    variantNo: 1,
    chunks: texts.map((_, index) => ({ pageNo: index + 1, chunkNo: 1 })),
  });
}

test("proceeding jobs embed exact versions once and leave step jobs alone", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "embed-v1", "Wohnraumgesetz");
    await collect(prisma, "embed-v2", "Geändertes Wohnraumgesetz", false);
    const inputs: string[] = [];
    const embed = async (text: string) => {
      inputs.push(text);
      return Array.from({ length: 1024 }, () => 0.1);
    };
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          embed,
          operation: EMBED_PROCEEDING,
        })
      ).status,
      "succeeded",
    );
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          embed,
          operation: EMBED_PROCEEDING,
        })
      ).status,
      "succeeded",
    );
    assert.deepEqual(inputs, [
      "Wohnraumgesetz\n\nRegelung für bezahlbaren Wohnraum.",
      "Geändertes Wohnraumgesetz",
    ]);
    assert.deepEqual(
      await prisma.dipEmbedding.findMany({
        select: {
          sourceVersionNo: true,
          sourceEntity: true,
          sourceApiId: true,
          model: true,
          documentInstruction: true,
        },
        orderBy: { sourceVersionNo: "asc" },
      }),
      [1, 2].map((sourceVersionNo) => ({
        sourceVersionNo,
        sourceEntity: "vorgang",
        sourceApiId: "123",
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
      })),
    );

    // A crash after storing the vector but before marking success may replay it.
    const first = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "embed-v1" },
    });
    await prisma.processingJob.update({
      where: { id: first.id },
      data: { status: "retrying", nextAttemptAt: new Date(0) },
    });
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          embed,
          operation: EMBED_PROCEEDING,
        })
      ).status,
      "succeeded",
    );
    assert.equal(await prisma.dipEmbedding.count(), 2);

    await prisma.$transaction((tx) =>
      enqueueJob(tx, {
        source: dipSource("/vorgangsposition", "21"),
        runId: "embed-v1",
        operation: EMBED_STEP,
        payload: { apiId: "456", versionNo: 1 },
      }),
    );
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          embed,
          operation: EMBED_PROCEEDING,
        })
      ).status,
      "empty",
    );
    assert.equal(
      await prisma.processingJob.count({
        where: { operation: EMBED_STEP, status: "pending" },
      }),
      1,
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("model failure retries without changing the DIP source or checkpoint", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "embed-offline", "Wohnraumgesetz");
    const before = await prisma.dipCheckpoint.findUniqueOrThrow({
      where: {
        endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
      },
    });
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          operation: EMBED_PROCEEDING,
          embed: async () => {
            throw new Error("model offline");
          },
        })
      ).status,
      "retrying",
    );
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "embed-offline" },
    });
    assert.equal(job.lastError, "model offline");
    assert.ok(await prisma.proceeding.findUnique({ where: { apiId: "123" } }));
    assert.deepEqual(
      await prisma.dipCheckpoint.findUniqueOrThrow({
        where: {
          endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
        },
      }),
      before,
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("a drain pass stops at the first retry and leaves the rest queued", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "drain-v1", "Wohnraumgesetz");
    await collect(prisma, "drain-v2", "Geändertes Wohnraumgesetz");
    await collect(prisma, "drain-v3", "Nochmals geändertes Wohnraumgesetz");
    let calls = 0;
    const outcomes = await drainDipEmbeddings(prisma, "drain-worker", {
      limit: 10,
      embed: async () => {
        calls++;
        if (calls === 2) throw new Error("model offline");
        return Array.from({ length: 1024 }, () => 0.1);
      },
    });
    // One failed attempt buys one retry, not the whole pass: the third job is
    // left pending for the next run instead of being claimed against a dead
    // provider.
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["succeeded", "retrying"],
    );
    assert.equal(calls, 2);
    assert.equal(
      await prisma.processingJob.count({
        where: { operation: EMBED_PROCEEDING, status: "pending" },
      }),
      1,
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("step jobs embed saved labels and available descriptions for each version", async () => {
  const prisma = await isolatedDatabase();
  const step = (label: string, abstract?: string) => ({
    id: "456",
    typ: "Vorgangsposition",
    vorgangsposition: label,
    zuordnung: "BT",
    gang: false,
    fortsetzung: false,
    nachtrag: false,
    vorgangstyp: "Gesetzentwurf",
    titel: "Wohnraumgesetz",
    dokumentart: "Drucksache",
    vorgang_id: "123",
    datum: "2026-10-14",
    aktualisiert: "2026-10-14T12:00:00+02:00",
    fundstelle: { id: "789", dokumentnummer: "21/1", datum: "2026-10-14" },
    aktivitaet_anzahl: 0,
    ...(abstract ? { abstract } : {}),
  });
  const collectStep = (runId: string, document: ReturnType<typeof step>) =>
    collectSteps(prisma, {
      runId,
      electoralTerm: 21,
      fetchPage: async () => ({
        documents: [document],
        cursor: "x",
        numFound: 1,
      }),
    });
  try {
    await collectStep(
      "step-v1",
      step("Einbringung", "Mehr bezahlbarer Wohnraum."),
    );
    await collectStep("step-v2", step("Beratung"));
    await collect(prisma, "later-proceeding", "Späterer Vorgang");
    const inputs: string[] = [];
    const embed = async (text: string) => {
      inputs.push(text);
      return Array.from({ length: 1024 }, () => 0.1);
    };
    assert.equal(
      (await processNextDipEmbedding(prisma, "worker", { embed })).status,
      "succeeded",
    );
    assert.equal(
      (
        await processNextDipEmbedding(prisma, "worker", {
          embed,
          operation: EMBED_STEP,
        })
      ).status,
      "succeeded",
    );
    assert.deepEqual(inputs, [
      "Wohnraumgesetz\n\nEinbringung\n\nMehr bezahlbarer Wohnraum.",
      "Wohnraumgesetz\n\nBeratung",
    ]);
    assert.deepEqual(
      await prisma.dipEmbedding.findMany({
        select: {
          sourceEntity: true,
          sourceApiId: true,
          sourceVersionNo: true,
          model: true,
          documentInstruction: true,
        },
        orderBy: { sourceVersionNo: "asc" },
      }),
      [1, 2].map((sourceVersionNo) => ({
        sourceEntity: "vorgangsposition",
        sourceApiId: "456",
        sourceVersionNo,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
      })),
    );
    assert.equal(
      await prisma.processingJob.count({
        where: { runId: "later-proceeding", status: "pending" },
      }),
      1,
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("admin retry of a DIP job preserves the completed collection run", async () => {
  const prisma = await isolatedDatabase();
  const previousPort = process.env.OLLAMA_PORT;
  const previousFormat = process.env.EMBEDDING_API_FORMAT;
  const previousBaseUrl = process.env.EMBEDDING_BASE_URL;
  try {
    await collect(prisma, "embed-admin-retry", "Wohnraumgesetz");
    const runBefore = await prisma.run.findUniqueOrThrow({
      where: { id: "embed-admin-retry" },
    });
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "embed-admin-retry" },
    });
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "exhausted", attempts: 5, lastError: "model offline" },
    });
    process.env.EMBEDDING_API_FORMAT = "ollama";
    delete process.env.EMBEDDING_BASE_URL;
    process.env.OLLAMA_PORT = "0";
    await retryJob(job.id);
    const retried = await prisma.processingJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(retried.status, "retrying");
    assert.match(
      retried.lastError ?? "",
      /OLLAMA_PORT must be a valid TCP port/,
    );
    assert.deepEqual(
      await prisma.run.findUniqueOrThrow({
        where: { id: "embed-admin-retry" },
      }),
      runBefore,
    );
  } finally {
    if (previousPort === undefined) delete process.env.OLLAMA_PORT;
    else process.env.OLLAMA_PORT = previousPort;
    if (previousFormat === undefined) delete process.env.EMBEDDING_API_FORMAT;
    else process.env.EMBEDDING_API_FORMAT = previousFormat;
    if (previousBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = previousBaseUrl;
    await prisma.$disconnect();
  }
});

test("a drain batch embeds passages in order under their own identities", async () => {
  const prisma = await isolatedDatabase();
  try {
    const texts = ["Erster Absatz", "Zweiter Absatz", "Dritter Absatz"];
    await queueDocumentPassages(prisma, "doc-batch", texts);
    const inputs: string[] = [];
    const vectors = texts.map((_, index) =>
      Array.from({ length: 1024 }, () => index + 1),
    );
    const outcomes = await drainDipEmbeddings(prisma, "batch-worker", {
      limit: 10,
      embedBatch: async (batch) => {
        inputs.push(...batch);
        return batch.map((text) => vectors[texts.indexOf(text)]!);
      },
    });
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    // Claim order is the queue's, not the caller's; every passage must still
    // receive the vector the provider returned for it.
    assert.deepEqual(inputs.slice().sort(), texts.slice().sort());
    const stored = await prisma.$queryRawUnsafe<
      { sourcePage: number; value: number }[]
    >(
      `SELECT source_page AS "sourcePage",
        trim(both '[' from split_part(embedding::text, ',', 1))::float8 AS value
       FROM ${qualifiedTable("dip_embeddings")}
       ORDER BY source_page`,
    );
    assert.deepEqual(
      stored,
      texts.map((_, index) => ({ sourcePage: index + 1, value: index + 1 })),
    );
    assert.deepEqual(
      await prisma.dipEmbedding.findMany({
        orderBy: { sourcePage: "asc" },
        select: {
          sourceEntity: true,
          sourceApiId: true,
          sourceVersionNo: true,
          sourcePage: true,
          sourceChunk: true,
          model: true,
        },
      }),
      texts.map((_, index) => ({
        sourceEntity: "dokument",
        sourceApiId: "doc-batch",
        sourceVersionNo: 1,
        sourcePage: index + 1,
        sourceChunk: 1,
        model: embeddingConfig().indexId,
      })),
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("a failed batch retries exactly its passages and leaves the rest pending", async () => {
  const prisma = await isolatedDatabase();
  try {
    const texts = Array.from({ length: 66 }, (_, index) => `Absatz ${index}`);
    await queueDocumentPassages(prisma, "doc-batch-fail", texts);
    let calls = 0;
    const outcomes = await drainDipEmbeddings(prisma, "batch-worker", {
      limit: 100,
      embedBatch: async (batch) => {
        calls++;
        assert.equal(batch.length, 64);
        throw new Error("model offline");
      },
    });
    assert.equal(calls, 1);
    assert.equal(outcomes.length, 64);
    assert.ok(outcomes.every((outcome) => outcome.status === "retrying"));
    assert.equal(
      await prisma.processingJob.count({ where: { status: "retrying" } }),
      64,
    );
    assert.equal(
      await prisma.processingJob.count({ where: { status: "pending" } }),
      2,
    );
    assert.equal(
      await prisma.jobAttempt.count({ where: { outcome: "retrying" } }),
      64,
    );
    assert.equal(await prisma.dipEmbedding.count(), 0);
  } finally {
    await prisma.$disconnect();
  }
});
