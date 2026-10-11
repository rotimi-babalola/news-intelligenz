import assert from "node:assert/strict";
import { test } from "node:test";
import { claimNextJob, failJob, requeueStaleClaims } from "../src/jobs.js";
import {
  EMBED_PROCEEDING,
  EMBED_STEP,
  PROCESS_DOCUMENT,
} from "../src/dip/jobs.js";
import { collectVorgang } from "../src/dip/vorgang.js";
import { collectSteps, type FetchStepPage } from "../src/dip/steps.js";
import { isolatedDatabase } from "./dip-test-db.js";

const NOW = new Date("2026-10-20T12:00:00+02:00");
const HOT_DATUM = "2026-10-09";
const COLD_DATUM = "2026-09-01";

function proceeding(id: string, aktualisiert = "2026-10-09T13:24:22+02:00") {
  return {
    id,
    typ: "Vorgang",
    vorgangstyp: "Kleine Anfrage",
    wahlperiode: 21,
    titel: `Titel ${id}`,
    aktualisiert,
  };
}

function step(id: string, vorgangId: string, datum: string) {
  return {
    id,
    typ: "Vorgangsposition",
    vorgangsposition: "Kleine Anfrage",
    zuordnung: "BT",
    gang: false,
    fortsetzung: false,
    nachtrag: false,
    vorgangstyp: "Kleine Anfrage",
    titel: `Titel ${vorgangId}`,
    dokumentart: "Drucksache",
    vorgang_id: vorgangId,
    datum,
    aktualisiert: `${datum}T13:24:22+02:00`,
    fundstelle: {
      id: `29${id}`,
      dokumentnummer: "21/1001",
      datum,
      pdf_url: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      dokumentart: "Drucksache",
      herausgeber: "BT",
      urheber: ["Fraktion DIE LINKE"],
    },
    aktivitaet_anzahl: 0,
  };
}

async function jobCounts(prisma: Awaited<ReturnType<typeof isolatedDatabase>>) {
  const rows = await prisma.processingJob.findMany({
    select: { operation: true, status: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows)
    counts[`${row.operation}:${row.status}`] =
      (counts[`${row.operation}:${row.status}`] ?? 0) + 1;
  return counts;
}

test("collection enqueues embedding jobs without holding the checkpoint", async () => {
  const prisma = await isolatedDatabase();
  const pages = (documents: unknown[]) => async () => ({
    documents,
    cursor: "x",
    numFound: 0,
  });
  await collectVorgang(prisma, {
    runId: "dip-jobs-1",
    electoralTerm: 21,
    fetchPage: pages([proceeding("1"), proceeding("2")]),
  });
  // Checkpoints advance while downstream work is still pending.
  assert.deepEqual(await jobCounts(prisma), {
    [`${EMBED_PROCEEDING}:pending`]: 2,
  });
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.ok(checkpoint.updatedThrough instanceof Date);

  // Unchanged observations enqueue no further work.
  await collectVorgang(prisma, {
    runId: "dip-jobs-2",
    electoralTerm: 21,
    fetchPage: pages([proceeding("1"), proceeding("2")]),
  });
  assert.deepEqual(await jobCounts(prisma), {
    [`${EMBED_PROCEEDING}:pending`]: 2,
  });

  // Changed text enqueues exactly one job for the new version.
  await collectVorgang(prisma, {
    runId: "dip-jobs-3",
    electoralTerm: 21,
    fetchPage: pages([
      proceeding("1"),
      { ...proceeding("2"), titel: "Neuer Titel" },
    ]),
  });
  assert.deepEqual(await jobCounts(prisma), {
    [`${EMBED_PROCEEDING}:pending`]: 3,
  });
  const retry = await prisma.processingJob.findFirstOrThrow({
    where: {
      operation: EMBED_PROCEEDING,
      payload: { equals: { apiId: "2", versionNo: 2 } },
    },
  });
  assert.equal(retry.runId, "dip-jobs-3");
  await prisma.$disconnect();
});

test("hot document references queue PDF work; cold ones wait for on-demand", async () => {
  const prisma = await isolatedDatabase();
  await prisma.proceeding.create({
    data: {
      apiId: "340135",
      title: "Titel",
      proceedingType: "Kleine Anfrage",
      electoralTerm: 21,
      sourceUpdatedAt: new Date("2026-10-09T13:24:22+02:00"),
      metadata: {},
    },
  });
  const fetchPage: FetchStepPage = async () => ({
    documents: [
      step("701400", "340135", HOT_DATUM),
      step("701401", "340135", COLD_DATUM),
    ],
    cursor: "x",
    numFound: 0,
  });
  await collectSteps(prisma, {
    runId: "dip-jobs-steps",
    electoralTerm: 21,
    now: NOW,
    fetchPage,
  });
  assert.deepEqual(await jobCounts(prisma), {
    [`${EMBED_STEP}:pending`]: 2,
    [`${PROCESS_DOCUMENT}:pending`]: 1,
  });
  const docJob = await prisma.processingJob.findFirstOrThrow({
    where: { operation: PROCESS_DOCUMENT },
  });
  assert.equal((docJob.payload as { stepApiId: string }).stepApiId, "701400");

  // Unchanged replay queues nothing further.
  await collectSteps(prisma, {
    runId: "dip-jobs-steps-2",
    electoralTerm: 21,
    now: NOW,
    fetchPage,
  });
  assert.deepEqual(await jobCounts(prisma), {
    [`${EMBED_STEP}:pending`]: 2,
    [`${PROCESS_DOCUMENT}:pending`]: 1,
  });
  await prisma.$disconnect();
});

test("downstream failure leaves records and checkpoints intact", async () => {
  const prisma = await isolatedDatabase();
  await collectVorgang(prisma, {
    runId: "dip-jobs-fail",
    electoralTerm: 21,
    fetchPage: async () => ({
      documents: [proceeding("1")],
      cursor: "x",
      numFound: 0,
    }),
  });
  const before = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  const claimed = await claimNextJob(prisma, "test-worker");
  assert.ok(claimed);
  assert.equal(claimed.operation, EMBED_PROCEEDING);
  await failJob(prisma, claimed, "test-worker", new Error("model offline"));
  const failed = await prisma.processingJob.findUniqueOrThrow({
    where: { id: claimed.id },
  });
  assert.equal(failed.status, "retrying");
  assert.equal(failed.lastError, "model offline");
  const after = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(after, before);
  assert.ok(await prisma.proceeding.findUnique({ where: { apiId: "1" } }));
  await prisma.$disconnect();
});

test("records and jobs survive a worker restart", async () => {
  const prisma = await isolatedDatabase();
  await collectVorgang(prisma, {
    runId: "dip-jobs-restart",
    electoralTerm: 21,
    fetchPage: async () => ({
      documents: [proceeding("1")],
      cursor: "x",
      numFound: 0,
    }),
  });
  const claimed = await claimNextJob(prisma, "dying-worker");
  assert.ok(claimed);
  // The worker dies mid-job: fresh connections still see everything, and the
  // stale claim becomes reclaimable through the standard recovery path.
  const { database } = await import("../src/db.js");
  const fresh = database();
  assert.ok(await fresh.proceeding.findUnique({ where: { apiId: "1" } }));
  assert.equal(
    await fresh.processingJob.count({ where: { operation: EMBED_PROCEEDING } }),
    1,
  );
  await fresh.processingJob.update({
    where: { id: claimed.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  const recovered = await requeueStaleClaims(fresh);
  assert.equal(recovered.count, 1);
  const reclaimed = await claimNextJob(fresh, "new-worker");
  assert.ok(reclaimed);
  assert.equal(reclaimed.dedupeKey, claimed.dedupeKey);
  await prisma.$disconnect();
  await fresh.$disconnect();
});

test("incremental windows resume from the checkpoint", async () => {
  const prisma = await isolatedDatabase();
  await collectVorgang(prisma, {
    runId: "dip-jobs-base",
    electoralTerm: 21,
    fetchPage: async ({ cursor }) =>
      cursor
        ? { documents: [], cursor, numFound: 0 }
        : {
            documents: [proceeding("1", "2026-10-09T13:24:22+02:00")],
            cursor: "c2",
            numFound: 0,
          },
  });
  const base = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.equal(base.updatedThrough?.toISOString(), "2026-10-09T11:24:22.000Z");

  const seen: unknown[] = [];
  const updated = await collectVorgang(prisma, {
    runId: "dip-jobs-window",
    electoralTerm: 21,
    updatedFrom: new Date("2026-10-10T00:00:00+02:00"),
    updatedTo: new Date("2026-10-11T00:00:00+02:00"),
    fetchPage: async (params) => {
      seen.push(params);
      return {
        documents: [
          { ...proceeding("1", "2026-10-10T10:00:00+02:00"), titel: "Neu" },
        ],
        cursor: params.cursor ?? "w2",
        numFound: 0,
      };
    },
  });
  assert.equal(updated.versionsAdded, 1);
  // The window, not the fetch, defines the query: filters stay explicit and
  // unchanged while only the cursor moves.
  assert.deepEqual(seen, [
    {
      wahlperiode: 21,
      aktualisiertStart: "2026-10-09T22:00:00.000Z",
      aktualisiertEnd: "2026-10-10T22:00:00.000Z",
      cursor: undefined,
    },
    {
      wahlperiode: 21,
      aktualisiertStart: "2026-10-09T22:00:00.000Z",
      aktualisiertEnd: "2026-10-10T22:00:00.000Z",
      cursor: "w2",
    },
  ]);
  const next = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.equal(next.updatedThrough?.toISOString(), "2026-10-10T22:00:00.000Z");
  await prisma.$disconnect();
});
