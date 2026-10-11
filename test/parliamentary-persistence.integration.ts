import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";

const root = process.cwd();

async function isolatedDatabase() {
  const configured = new URL(process.env.DATABASE_URL!);
  configured.searchParams.delete("schema");
  const baseUrl = configured.toString();
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = `${baseUrl}?schema=${schema}`;
  process.env.DATABASE_URL = url;
  const env = { ...process.env, DATABASE_URL: url };
  await promisify(execFile)("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env,
    cwd: root,
  });
  const { database } = await import("../src/db.js");
  return database();
}

const proceeding = (apiId: string) => ({
  apiId,
  title: "Siebte Verordnung über die Freigabe von Vorräten",
  proceedingType: "Rechtsverordnung",
  electoralTerm: 21,
  deliberationState: "Abgeschlossen",
  documentDate: new Date("2026-10-09"),
  sourceUpdatedAt: new Date("2026-10-09T16:32:14+02:00"),
  metadata: { initiative: ["Bundesministerium für Wirtschaft und Energie"] },
});

const step = (apiId: string, proceedingApiId: string) => ({
  apiId,
  proceedingApiId,
  institution: "BR",
  stepLabel: "Verordnung der Bundesregierung",
  title: "Siebte Verordnung über die Freigabe von Vorräten",
  documentType: "Drucksache",
  documentDate: new Date("2026-10-09"),
  sourceUpdatedAt: new Date("2026-10-09T16:32:14+02:00"),
  metadata: { gang: true },
});

test("parliamentary records persist with versions, refs, and discoveries", async () => {
  const prisma = await isolatedDatabase();
  await prisma.run.create({
    data: {
      id: "dip-run-1",
      feedId: "/vorgang",
      sourceKind: "dip_endpoint",
      sourceScope: { electoralTerm: 21 },
      inputHash: "hash-1",
      status: "completed",
    },
  });
  await prisma.proceeding.create({ data: proceeding("340161") });
  await prisma.proceedingVersion.create({
    data: {
      proceedingApiId: "340161",
      versionNo: 1,
      contentHash: "hash-v1",
      snapshot: proceeding("340161"),
      sourceUpdatedAt: new Date("2026-10-09T16:32:14+02:00"),
      runId: "dip-run-1",
    },
  });
  await prisma.proceedingStep.create({ data: step("701425", "340161") });
  await prisma.proceedingStepVersion.create({
    data: {
      stepApiId: "701425",
      versionNo: 1,
      contentHash: "hash-s1",
      snapshot: step("701425", "340161"),
      sourceUpdatedAt: new Date("2026-10-09T16:32:14+02:00"),
      runId: "dip-run-1",
    },
  });
  await prisma.documentReference.create({
    data: {
      stepApiId: "701425",
      proceedingApiId: "340161",
      referenceId: "291522",
      documentNumber: "583/26",
      pdfUrl: "https://dserver.bundestag.de/brd/2026/0583-26.pdf",
      documentDate: new Date("2026-10-09"),
      metadata: { dokumentart: "Drucksache", herausgeber: "BR" },
    },
  });
  await prisma.parliamentaryDiscovery.create({
    data: { runId: "dip-run-1", entity: "vorgang", apiId: "340161" },
  });

  assert.equal(
    (await prisma.proceeding.findUniqueOrThrow({ where: { apiId: "340161" } }))
      .title,
    "Siebte Verordnung über die Freigabe von Vorräten",
  );
  assert.equal(
    (
      await prisma.documentReference.findUniqueOrThrow({
        where: { stepApiId: "701425" },
      })
    ).documentNumber,
    "583/26",
  );
  // Replay of the same run reuses the encounter row instead of duplicating it.
  await prisma.parliamentaryDiscovery.upsert({
    where: {
      runId_entity_apiId: {
        runId: "dip-run-1",
        entity: "vorgang",
        apiId: "340161",
      },
    },
    create: { runId: "dip-run-1", entity: "vorgang", apiId: "340161" },
    update: {},
  });
  assert.equal(await prisma.parliamentaryDiscovery.count(), 1);
  // A new run records a distinct encounter for the same record.
  await prisma.run.create({
    data: {
      id: "dip-run-2",
      feedId: "/vorgang",
      sourceKind: "dip_endpoint",
      sourceScope: { electoralTerm: 21 },
      inputHash: "hash-2",
      status: "completed",
    },
  });
  await prisma.parliamentaryDiscovery.create({
    data: { runId: "dip-run-2", entity: "vorgang", apiId: "340161" },
  });
  assert.equal(await prisma.parliamentaryDiscovery.count(), 2);
  assert.equal(await prisma.proceedingVersion.count(), 1);
  await prisma.$disconnect();
});

test("steps with unobserved parents are retained, duplicate versions rejected", async () => {
  const prisma = await isolatedDatabase();
  // No proceeding 999999 exists: the step must still persist for inspection.
  await prisma.proceedingStep.create({ data: step("701299", "999999") });
  assert.equal(
    (
      await prisma.proceedingStep.findUniqueOrThrow({
        where: { apiId: "701299" },
      })
    ).proceedingApiId,
    "999999",
  );
  assert.equal(
    await prisma.proceeding.count({ where: { apiId: "999999" } }),
    0,
  );

  await prisma.proceeding.create({ data: proceeding("340135") });
  await prisma.proceedingVersion.create({
    data: {
      proceedingApiId: "340135",
      versionNo: 1,
      contentHash: "hash-a",
      snapshot: {},
      sourceUpdatedAt: new Date("2026-10-09T13:24:22+02:00"),
    },
  });
  await assert.rejects(
    prisma.proceedingVersion.create({
      data: {
        proceedingApiId: "340135",
        versionNo: 1,
        contentHash: "hash-b",
        snapshot: {},
        sourceUpdatedAt: new Date("2026-10-09T13:24:22+02:00"),
      },
    }),
  );
  await prisma.$disconnect();
});

test("checkpoints track per-endpoint progress and existing news storage is intact", async () => {
  const prisma = await isolatedDatabase();
  await prisma.dipCheckpoint.upsert({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
    create: {
      endpoint: "/vorgang",
      electoralTerm: 21,
      updatedThrough: new Date("2026-10-09T16:32:14+02:00"),
    },
    update: { updatedThrough: new Date("2026-10-09T16:32:14+02:00") },
  });
  await prisma.dipCheckpoint.upsert({
    where: {
      endpoint_electoralTerm: {
        endpoint: "/vorgangsposition",
        electoralTerm: 21,
      },
    },
    create: { endpoint: "/vorgangsposition", electoralTerm: 21 },
    update: {},
  });
  assert.equal(await prisma.dipCheckpoint.count(), 2);
  assert.ok(
    (
      await prisma.dipCheckpoint.findUniqueOrThrow({
        where: {
          endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
        },
      })
    ).updatedThrough instanceof Date,
  );

  // The additive migration must not disturb news storage.
  await prisma.publication.create({
    data: {
      id: randomUUID(),
      publisher: "Deutschlandfunk",
      headline: "Nachrichten",
      originalUrl: "https://www.deutschlandfunk.de/nachrichten-1",
      language: "de",
    },
  });
  assert.equal(await prisma.publication.count(), 1);
  await prisma.$disconnect();
});
