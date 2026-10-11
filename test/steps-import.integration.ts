import assert from "node:assert/strict";
import { test } from "node:test";
import { collectVorgang } from "../src/dip/vorgang.js";
import { collectSteps, type FetchStepPage } from "../src/dip/steps.js";
import { isolatedDatabase } from "./dip-test-db.js";

function proceeding(id: string, term = 21) {
  return {
    apiId: id,
    title: `Titel ${id}`,
    proceedingType: "Kleine Anfrage",
    electoralTerm: term,
    sourceUpdatedAt: new Date("2026-10-09T13:24:22+02:00"),
    metadata: {},
  };
}

function step(
  id: string,
  vorgangId: string,
  overrides: Record<string, unknown> = {},
) {
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
    datum: "2026-10-09",
    aktualisiert: "2026-10-09T13:24:22+02:00",
    fundstelle: {
      id: `29${id}`,
      dokumentnummer: "21/1001",
      datum: "2026-10-09",
      pdf_url: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      dokumentart: "Drucksache",
      herausgeber: "BT",
      urheber: ["Fraktion DIE LINKE"],
    },
    aktivitaet_anzahl: 0,
    ...overrides,
  };
}

function fakeSteps(
  pages: Record<string, { documents: unknown[]; next: string }>,
) {
  const calls: Parameters<FetchStepPage>[0][] = [];
  const fetchPage: FetchStepPage = async (params) => {
    calls.push(params);
    const key = params.cursor ?? "start";
    const page = pages[key];
    if (!page) throw new Error(`unexpected cursor ${key}`);
    return { documents: page.documents, cursor: page.next, numFound: 0 };
  };
  return { fetchPage, calls };
}

test("steps import with parent links, institutions, and document references", async () => {
  const prisma = await isolatedDatabase();
  await prisma.proceeding.create({ data: proceeding("340135") });
  await prisma.proceeding.create({ data: proceeding("340161") });
  const { fetchPage, calls } = fakeSteps({
    start: {
      documents: [
        step("701400", "340135"),
        step("701425", "340161", { zuordnung: "BR" }),
      ],
      next: "c2",
    },
    c2: { documents: [], next: "c2" },
  });
  const result = await collectSteps(prisma, {
    runId: "dip-steps-1",
    electoralTerm: 21,
    fetchPage,
  });
  assert.deepEqual(
    { valid: result.valid, invalid: result.invalid, stored: result.stored },
    { valid: 2, invalid: 0, stored: 2 },
  );
  assert.equal(
    (
      await prisma.proceedingStep.findUniqueOrThrow({
        where: { apiId: "701425" },
      })
    ).institution,
    "BR",
  );
  const ref = await prisma.documentReference.findUniqueOrThrow({
    where: { stepApiId: "701400" },
  });
  assert.deepEqual(
    {
      referenceId: ref.referenceId,
      documentNumber: ref.documentNumber,
      pdfUrl: ref.pdfUrl,
      parent: ref.proceedingApiId,
    },
    {
      referenceId: "29701400",
      documentNumber: "21/1001",
      pdfUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      parent: "340135",
    },
  );
  assert.ok(ref.documentDate instanceof Date);
  assert.equal(
    await prisma.parliamentaryDiscovery.count({
      where: { runId: "dip-steps-1" },
    }),
    2,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.wahlperiode === 21));
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: {
        endpoint: "/vorgangsposition",
        electoralTerm: 21,
      },
    },
  });
  assert.ok(checkpoint.updatedThrough instanceof Date);
  await prisma.$disconnect();
});

test("cross-term and missing parents are retained with their links", async () => {
  const prisma = await isolatedDatabase();
  // Parent from the previous term: the term filter must not orphan the step.
  await prisma.proceeding.create({ data: proceeding("99001", 20) });
  const result = await collectSteps(prisma, {
    runId: "dip-steps-cross",
    electoralTerm: 21,
    fetchPage: fakeSteps({
      start: {
        documents: [step("701300", "99001"), step("701299", "999999")],
        next: "x",
      },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.equal(result.stored, 2);
  assert.equal(
    (
      await prisma.proceedingStep.findUniqueOrThrow({
        where: { apiId: "701300" },
      })
    ).proceedingApiId,
    "99001",
  );
  const orphan = await prisma.proceedingStep.findUniqueOrThrow({
    where: { apiId: "701299" },
  });
  assert.equal(orphan.proceedingApiId, "999999");
  assert.equal(
    await prisma.proceeding.count({ where: { apiId: "999999" } }),
    0,
  );
  await prisma.$disconnect();
});

test("missing parents backfill when retrievable, else stay unresolved", async () => {
  const prisma = await isolatedDatabase();
  const fetched = await collectSteps(prisma, {
    runId: "dip-steps-backfill",
    electoralTerm: 21,
    followStoredParents: true,
    fetchPage: fakeSteps({
      start: { documents: [step("701400", "340135")], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
    fetchVorgang: async (id) =>
      id === "340135"
        ? {
            id: "340135",
            typ: "Vorgang",
            vorgangstyp: "Kleine Anfrage",
            wahlperiode: 21,
            titel: "Titel 340135",
            aktualisiert: "2026-10-09T13:24:22+02:00",
          }
        : null,
  });
  assert.equal(fetched.backfilled, 1);
  assert.ok(await prisma.proceeding.findUnique({ where: { apiId: "340135" } }));

  const unresolved = await collectSteps(prisma, {
    runId: "dip-steps-unresolved",
    electoralTerm: 21,
    followStoredParents: true,
    fetchPage: fakeSteps({
      start: { documents: [step("701299", "999999")], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
    fetchVorgang: async () => null,
  });
  assert.equal(unresolved.backfilled, 0);
  assert.equal(unresolved.stored, 1);
  assert.ok(
    await prisma.proceedingStep.findUnique({ where: { apiId: "701299" } }),
  );
  await prisma.$disconnect();
});

test("backfilled parents leave distinct candidate traces", async () => {
  const prisma = await isolatedDatabase();
  const result = await collectSteps(prisma, {
    runId: "dip-steps-backfill-traces",
    electoralTerm: 21,
    followStoredParents: true,
    fetchPage: fakeSteps({
      start: {
        documents: [step("701400", "340135"), step("701401", "340136")],
        next: "x",
      },
      x: { documents: [], next: "x" },
    }).fetchPage,
    fetchVorgang: async (id) => ({
      id,
      typ: "Vorgang",
      vorgangstyp: "Kleine Anfrage",
      wahlperiode: 21,
      titel: `Titel ${id}`,
      aktualisiert: "2026-10-09T13:24:22+02:00",
    }),
  });
  assert.equal(result.backfilled, 2);
  const traces = await prisma.candidate.findMany({
    where: { runId: "dip-steps-backfill-traces", itemIndex: { lt: 0 } },
    orderBy: { itemIndex: "asc" },
  });
  assert.deepEqual(
    traces.map((c) => c.itemIndex),
    [-2, -1],
  );
  await prisma.$disconnect();
});

test("changed steps version and update refs; replay adds nothing", async () => {
  const prisma = await isolatedDatabase();
  await prisma.proceeding.create({ data: proceeding("340135") });
  const pages = (documents: unknown[]) =>
    fakeSteps({
      start: { documents, next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage;
  await collectSteps(prisma, {
    runId: "dip-steps-v1",
    electoralTerm: 21,
    fetchPage: pages([step("701400", "340135")]),
  });
  const replay = await collectSteps(prisma, {
    runId: "dip-steps-v1",
    electoralTerm: 21,
    fetchPage: async () => {
      throw new Error("replayed runs must not refetch");
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(await prisma.proceedingStepVersion.count(), 1);

  const changedFundstelle = step("701400", "340135") as Record<string, unknown>;
  changedFundstelle["fundstelle"] = {
    ...(changedFundstelle["fundstelle"] as Record<string, unknown>),
    dokumentnummer: "21/1002",
  };
  const changed = await collectSteps(prisma, {
    runId: "dip-steps-v2",
    electoralTerm: 21,
    fetchPage: pages([changedFundstelle]),
  });
  assert.equal(changed.versionsAdded, 1);
  assert.equal(await prisma.proceedingStepVersion.count(), 2);
  assert.equal(
    (
      await prisma.documentReference.findUniqueOrThrow({
        where: { stepApiId: "701400" },
      })
    ).documentNumber,
    "21/1002",
  );
  await prisma.$disconnect();
});

test("local step collection follows the stored proceeding set without going silent", async () => {
  const prisma = await isolatedDatabase();
  await prisma.proceeding.create({ data: proceeding("340135") });
  const result = await collectSteps(prisma, {
    runId: "dip-steps-follow",
    electoralTerm: 21,
    followStoredParents: true,
    proceedingCap: 1,
    fetchPage: fakeSteps({
      start: {
        documents: [step("701400", "340135"), step("701425", "340161")],
        next: "x",
      },
      x: { documents: [], next: "x" },
    }).fetchPage,
    fetchVorgang: async (id) =>
      id === "340161"
        ? {
            id: "340161",
            typ: "Vorgang",
            vorgangstyp: "Rechtsverordnung",
            wahlperiode: 21,
            titel: "Titel 340161",
            aktualisiert: "2026-10-09T16:32:14+02:00",
          }
        : null,
  });
  // The in-scope step stores; the out-of-cap step is counted, not silent.
  assert.deepEqual(
    { stored: result.stored, capped: result.capped },
    { stored: 1, capped: 1 },
  );
  assert.ok(
    await prisma.proceedingStep.findUnique({ where: { apiId: "701400" } }),
  );
  assert.equal(
    await prisma.proceedingStep.findUnique({ where: { apiId: "701425" } }),
    null,
  );
  const skipped = await prisma.candidate.findFirstOrThrow({
    where: { runId: "dip-steps-follow", itemIndex: 1 },
  });
  assert.deepEqual(skipped.errors, []);
  await prisma.$disconnect();
});

test("unknown institutions and all four labels behave", async () => {
  const prisma = await isolatedDatabase();
  for (const id of ["1", "2", "3", "4"])
    await prisma.proceeding.create({ data: proceeding(id) });
  const result = await collectSteps(prisma, {
    runId: "dip-steps-institutions",
    electoralTerm: 21,
    fetchPage: fakeSteps({
      start: {
        documents: [
          step("1", "1", { zuordnung: "BT" }),
          step("2", "2", { zuordnung: "BR" }),
          step("3", "3", { zuordnung: "BV" }),
          step("4", "4", { zuordnung: "EK" }),
          step("5", "1", { zuordnung: "EU" }),
        ],
        next: "x",
      },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.deepEqual(
    { valid: result.valid, invalid: result.invalid },
    { valid: 4, invalid: 1 },
  );
  // Step 5 references proceeding "1" but has an unknown institution, so only
  // four steps persist.
  assert.equal(await prisma.proceedingStep.count(), 4);
  const bad = await prisma.candidate.findFirstOrThrow({
    where: { runId: "dip-steps-institutions", itemIndex: 4 },
  });
  assert.ok((bad.errors as unknown[]).length > 0);
  await prisma.$disconnect();
});

test("full proceeding import feeds step collection end to end", async () => {
  const prisma = await isolatedDatabase();
  const collected = await collectVorgang(prisma, {
    runId: "dip-e2e-vorgang",
    electoralTerm: 21,
    fetchPage: async ({ cursor }) =>
      cursor
        ? { documents: [], cursor, numFound: 0 }
        : {
            documents: [
              {
                id: "340135",
                typ: "Vorgang",
                vorgangstyp: "Kleine Anfrage",
                wahlperiode: 21,
                titel: "Titel 340135",
                aktualisiert: "2026-10-09T13:24:22+02:00",
              },
            ],
            cursor: "c2",
            numFound: 0,
          },
  });
  assert.equal(collected.stored, 1);
  const steps = await collectSteps(prisma, {
    runId: "dip-e2e-steps",
    electoralTerm: 21,
    followStoredParents: true,
    fetchPage: fakeSteps({
      start: { documents: [step("701400", "340135")], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
    fetchVorgang: async () => null,
  });
  assert.equal(steps.stored, 1);
  assert.equal(steps.backfilled, 0);
  await prisma.$disconnect();
});
