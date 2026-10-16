import assert from "node:assert/strict";
import { test } from "node:test";
import { retryJob } from "../src/admin/service.js";
import {
  processNextDipEmbedding,
  EMBEDDING_MODEL,
  DOCUMENT_INSTRUCTION,
} from "../src/dip/embedding.js";
import { EMBED_PROCEEDING, EMBED_STEP } from "../src/dip/jobs.js";
import { collectVorgang } from "../src/dip/vorgang.js";
import { collectSteps } from "../src/dip/steps.js";
import { dipSource, enqueueJob } from "../src/jobs.js";
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
        model: EMBEDDING_MODEL,
        documentInstruction: DOCUMENT_INSTRUCTION,
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
        model: EMBEDDING_MODEL,
        documentInstruction: DOCUMENT_INSTRUCTION,
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
    process.env.OLLAMA_PORT = "0";
    await retryJob(job.id);
    const retried = await prisma.processingJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(retried.status, "retrying");
    assert.deepEqual(
      await prisma.run.findUniqueOrThrow({
        where: { id: "embed-admin-retry" },
      }),
      runBefore,
    );
  } finally {
    if (previousPort === undefined) delete process.env.OLLAMA_PORT;
    else process.env.OLLAMA_PORT = previousPort;
    await prisma.$disconnect();
  }
});
